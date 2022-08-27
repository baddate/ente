import { setToUploadFiles } from '../api/upload';
import { getValidPaths } from '../services/fs';
import { uploadStatusStore } from '../stores/upload.store';
import { FILE_PATH_TYPE, FILE_PATH_KEYS } from '../types';

export const getSavedFilePaths = (type: FILE_PATH_TYPE) => {
    const paths =
        getValidPaths(
            uploadStatusStore.get(FILE_PATH_KEYS[type]) as string[]
        ) ?? [];

    setToUploadFiles(type, paths);
    return paths;
};
