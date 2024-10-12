const { createReadStream } = require('fs');
const { writeFile, stat } = require('fs/promises');
const { basename } = require('path');
const { photoprism, immich } = require('./env.json');

class UploadFile extends File {
  filepath;
  _size;
  constructor(filepath, _size) {
    super([], basename(filepath));
    this.filepath = filepath;
    this._size = _size;
  }

  get size() {
    return this._size;
  }

  stream() {
    return createReadStream(this.filepath);
  }
}

(async () => {
  const photoprismAlbumsResponse = await fetch(
    `${photoprism.url}/api/v1/albums?count=-1&type=album`,
    {
      headers: {
        'Content-Type': `application/json`,
        Authorization: `Bearer ${photoprism.accessToken}`,
      },
    }
  );

  const photoprismAlbums = await photoprismAlbumsResponse.json();

  console.log(`${photoprismAlbums.length} album(s) found on Photoprism`);

  const immichAlbumsResponse = await fetch(`${immich.url}/api/albums`, {
    headers: {
      'Content-Type': `application/json`,
      'x-api-key': immich.apiKey,
    },
  });

  const immichAlbums = await immichAlbumsResponse.json();

  const immichAlbumsNames = new Set(
    immichAlbums.map((immichAlbum) => immichAlbum.albumName)
  );

  console.log(`${immichAlbums.length} album(s) found on Immich`);

  const photoprismAlbumsMissingInImmich = photoprismAlbums.filter(
    (photoprismAlbum) => !immichAlbumsNames.has(photoprismAlbum.Title)
  );

  console.log(
    `Out of the ${photoprismAlbums.length} photoprism albums, ${photoprismAlbumsMissingInImmich.length} are missing in Immich and will be created`
  );

  for (const photoprismAlbum of photoprismAlbumsMissingInImmich) {
    console.log(`Creating "${photoprismAlbum.Title}"`);

    await fetch(`${immich.url}/api/albums`, {
      method: 'POST',
      headers: {
        'Content-Type': `application/json`,
        'x-api-key': immich.apiKey,
      },
      body: JSON.stringify({
        albumName: photoprismAlbum.Title,
      }),
    });
  }

  const immichAlbumsAfterCopyingPhotoprismAlbumsResponse = await fetch(
    `${immich.url}/api/albums`,
    {
      headers: {
        'Content-Type': `application/json`,
        'x-api-key': immich.apiKey,
      },
    }
  );

  const immichAlbumsAfterCopyingPhotoprismAlbums =
    await immichAlbumsAfterCopyingPhotoprismAlbumsResponse.json();

  const immichAlbumNameToAlbumId =
    immichAlbumsAfterCopyingPhotoprismAlbums.reduce((acc, curr) => {
      acc[curr.albumName] = curr.id;
      return acc;
    }, {});

  const photoprismPhotosRes = await fetch(
    `${photoprism.url}/api/v1/photos?count=-1`,
    {
      headers: {
        'Content-Type': `application/json`,
        Authorization: `Bearer ${photoprism.accessToken}`,
      },
    }
  );

  const photoprismPhotos = (await photoprismPhotosRes.json()).filter(
    (photo) =>
      // we do exclude the ones different than '/' as we don't want the sidecar ones for example
      photo.FileRoot === '/'
  );

  console.log(`${photoprismPhotos.length} photos found on Photoprism`);

  const photoprismPhotosImmichUploadError = [];
  const immichAddToAlbumError = [];
  const immichAssetUpdateError = [];

  try {
    const startValue = getArgValue('--start') || 0;

    for (const [index, photoprismPhoto] of photoprismPhotos.entries()) {
      if (index < startValue) {
        continue;
      }
      const body = new FormData();

      const path = `/originals/${photoprismPhoto.FileName}`;

      const stats = await stat(path);

      body.append(
        'deviceAssetId',
        `${basename(path)}-${stats.size}`.replaceAll(/\s+/g, '')
      );
      body.append('deviceId', 'CLI');
      body.append('fileCreatedAt', photoprismPhoto.CreatedAt);
      body.append('fileModifiedAt', photoprismPhoto.UpdatedAt);
      body.append('fileSize', String(stats.size));
      body.append('isFavorite', photoprismPhoto.Favorite);
      body.append('assetData', new UploadFile(path, stats.size));
      
      let uploadAssetRes
      try {
         uploadAssetRes = await fetch(`${immich.url}/api/assets`, {
          method: 'POST',
          headers: {
            'x-api-key': immich.apiKey,
            // avoid re-uploading for nothing if it's a duplicate
            'x-immich-checksum': photoprismPhoto.Hash,
          },
          body,
        });
      }
      catch (error) {
        console.error(`Error uploading ${photoprismPhoto.FileName}`);
        console.error(error);
        continue;
      }

      const uploadAssetResult = await uploadAssetRes.json();

      console.log(`${index + 1} / ${photoprismPhotos.length} : ${photoprismPhoto.FileName}`);

      if (!uploadAssetRes.ok) {
        console.error(`Error uploading ${photoprismPhoto.FileName}: ${uploadAssetResult.message}`);

        photoprismPhotosImmichUploadError.push({
          photoprismPhoto,
          uploadAssetResult,
        });
        // skip to the next photo
        continue;
      }

      // photo uploaded successfully, now we'll
      // - add the metadata from Photoprism as GPS coordinates have been manually added on some pics and are not in the original file
      // - try to see if it was in any albums and if so, add it to Immich albums as well

      if (photoprismPhoto.Lat && photoprismPhoto.Lng) {
        const immichAssetUpdateRes = await fetch(`${immich.url}/api/assets`, {
          method: 'PUT',
          headers: {
            'Content-Type': `application/json`,
            'x-api-key': immich.apiKey,
          },
          body: JSON.stringify({
            ids: [uploadAssetResult.id],
            latitude: photoprismPhoto.Lat,
            longitude: photoprismPhoto.Lng,
          }),
        });

        if (!immichAssetUpdateRes.ok) {
          console.error('Something went wrong while updating the asset');
          immichAssetUpdateError.push({
            assetId: uploadAssetResult.id,
            immichAssetUpdateRes,
          });
        }
      }

      const photoprismPhotoRes = await fetch(
        `${photoprism.url}/api/v1/photos/${photoprismPhoto.UID}`,
        {
          headers: {
            'Content-Type': `application/json`,
            Authorization: `Bearer ${photoprism.accessToken}`,
          },
        }
      );

      const photoprismPhotoDetails = await photoprismPhotoRes.json();

      for (const photoprismPhotoAlbum of photoprismPhotoDetails.Albums) {
        const immichAlbumId =
          immichAlbumNameToAlbumId[photoprismPhotoAlbum.Title];

        if (!immichAlbumId) {
          // this should never happen as we created all the albums in
          // Immich with the exact same name as the one in Photoprism
          throw new Error(
            `Cannot find an album in Immich for the album "${photoprismPhotoAlbum.Title}"`
          );
        }

        const addImmichPhotoToAlbumRes = await fetch(
          `${immich.url}/api/albums/${immichAlbumId}/assets`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': `application/json`,
              'x-api-key': immich.apiKey,
            },
            body: JSON.stringify({
              ids: [uploadAssetResult.id],
            }),
          }
        );

        const addImmichPhotoToAlbumResult = await addImmichPhotoToAlbumRes.json();

        if (!addImmichPhotoToAlbumRes.ok) {
          console.error('Something went wrong while adding the file to album(s)');
          immichAddToAlbumError.push({
            photoprismPhoto,
            immichAlbumId,
            photoId: uploadAssetResult.id,
            addImmichPhotoToAlbumResult,
          });
        }
      }
    }

  } catch (error) {
    console.error(error);
  } finally {
    if (
      photoprismPhotosImmichUploadError.length ||
      immichAddToAlbumError.length ||
      immichAssetUpdateError.length
    ) {
      // write a new log in case the program was ran multiple times as we wouldn't want to lose anything
      const formattedDate = new Date().toISOString().replace(/:/g, '-');

      await writeFile(
        `error-logs-${formattedDate}.json`,
        JSON.stringify(
          {
            photoprismPhotosImmichUploadError,
            immichAddToAlbumError,
            immichAssetUpdateError,
          },
          null,
          2
        )
      );

      console.log(
        `The errors have been logged in error-logs-${formattedDate}.json`
      );
    }

    console.log('Done');
  }
})();


const getArgValue = (argName) => {
  const args = process.argv.slice(2);
  const index = args.indexOf(argName);
  return (index !== -1 && args[index + 1]) ? args[index + 1] : null;
};