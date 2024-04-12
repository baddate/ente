import { CacheStorageService, type EnteCache } from "@/next/cache";
import log from "@/next/log";
import { APPS } from "@ente/shared/apps/constants";
import ComlinkCryptoWorker from "@ente/shared/crypto";
import { DedicatedCryptoWorker } from "@ente/shared/crypto/internal/crypto.worker";
import { CustomError } from "@ente/shared/error";
import { Events, eventBus } from "@ente/shared/events";
import { Remote } from "comlink";
import { FILE_TYPE } from "constants/file";
import isElectron from "is-electron";
import { EnteFile } from "types/file";
import {
    generateStreamFromArrayBuffer,
    getRenderableFileURL,
} from "utils/file";
import { isInternalUser } from "utils/user";
import { PhotosDownloadClient } from "./clients/photos";
import { PublicAlbumsDownloadClient } from "./clients/publicAlbums";

export type LivePhotoSourceURL = {
    image: () => Promise<string>;
    video: () => Promise<string>;
};

export type LoadedLivePhotoSourceURL = {
    image: string;
    video: string;
};

export type SourceURLs = {
    url: string | LivePhotoSourceURL | LoadedLivePhotoSourceURL;
    isOriginal: boolean;
    isRenderable: boolean;
    type: "normal" | "livePhoto";
};

export type OnDownloadProgress = (event: {
    loaded: number;
    total: number;
}) => void;

export interface DownloadClient {
    updateTokens: (token: string, passwordToken?: string) => void;
    updateTimeout: (timeout: number) => void;
    downloadThumbnail: (
        file: EnteFile,
        timeout?: number,
    ) => Promise<Uint8Array>;
    downloadFile: (
        file: EnteFile,
        onDownloadProgress: OnDownloadProgress,
    ) => Promise<Uint8Array>;
    downloadFileStream: (file: EnteFile) => Promise<Response>;
}

class DownloadManagerImpl {
    private ready: boolean = false;
    private downloadClient: DownloadClient;
    private thumbnailCache?: EnteCache;
    // disk cache is only available on electron
    private diskFileCache?: EnteCache;
    private cryptoWorker: Remote<DedicatedCryptoWorker>;

    private fileObjectURLPromises = new Map<number, Promise<SourceURLs>>();
    private fileConversionPromises = new Map<number, Promise<SourceURLs>>();
    private thumbnailObjectURLPromises = new Map<number, Promise<string>>();

    private fileDownloadProgress = new Map<number, number>();

    private progressUpdater: (value: Map<number, number>) => void = () => {};

    async init(
        app: APPS,
        tokens?: { token: string; passwordToken?: string } | { token: string },
        timeout?: number,
    ) {
        try {
            if (this.ready) {
                log.info("DownloadManager already initialized");
                return;
            }
            this.downloadClient = createDownloadClient(app, tokens, timeout);
            this.thumbnailCache = await openThumbnailCache();
            this.diskFileCache = isElectron() && (await openDiskFileCache());
            this.cryptoWorker = await ComlinkCryptoWorker.getInstance();
            this.ready = true;
            eventBus.on(Events.LOGOUT, this.logoutHandler.bind(this), this);
        } catch (e) {
            log.error("DownloadManager init failed", e);
            throw e;
        }
    }

    private async logoutHandler() {
        try {
            log.info("downloadManger logoutHandler started");
            this.ready = false;
            this.cryptoWorker = null;
            this.downloadClient = null;
            this.fileObjectURLPromises.clear();
            this.fileConversionPromises.clear();
            this.thumbnailObjectURLPromises.clear();
            this.fileDownloadProgress.clear();
            this.progressUpdater = () => {};
            log.info("downloadManager logoutHandler completed");
        } catch (e) {
            log.error("downloadManager logoutHandler failed", e);
        }
    }

    updateToken(token: string, passwordToken?: string) {
        this.downloadClient.updateTokens(token, passwordToken);
    }

    updateCryptoWorker(cryptoWorker: Remote<DedicatedCryptoWorker>) {
        this.cryptoWorker = cryptoWorker;
    }

    updateTimeout(timeout: number) {
        this.downloadClient.updateTimeout(timeout);
    }

    setProgressUpdater(progressUpdater: (value: Map<number, number>) => void) {
        this.progressUpdater = progressUpdater;
    }

    private async getCachedThumbnail(fileID: number) {
        try {
            const cacheResp: Response = await this.thumbnailCache?.match(
                fileID.toString(),
            );

            if (cacheResp) {
                return new Uint8Array(await cacheResp.arrayBuffer());
            }
        } catch (e) {
            log.error("failed to get cached thumbnail", e);
            throw e;
        }
    }
    private async getCachedFile(file: EnteFile): Promise<Response> {
        try {
            if (!this.diskFileCache) {
                return null;
            }
            const cacheResp: Response = await this.diskFileCache?.match(
                file.id.toString(),
            );
            return cacheResp?.clone();
        } catch (e) {
            log.error("failed to get cached file", e);
            throw e;
        }
    }

    private downloadThumb = async (file: EnteFile) => {
        const encrypted = await this.downloadClient.downloadThumbnail(file);
        const decrypted = await this.cryptoWorker.decryptThumbnail(
            encrypted,
            await this.cryptoWorker.fromB64(file.thumbnail.decryptionHeader),
            file.key,
        );
        return decrypted;
    };

    async getThumbnail(file: EnteFile, localOnly = false) {
        try {
            if (!this.ready) {
                throw Error(CustomError.DOWNLOAD_MANAGER_NOT_READY);
            }
            const cachedThumb = await this.getCachedThumbnail(file.id);
            if (cachedThumb) {
                return cachedThumb;
            }
            if (localOnly) {
                return null;
            }
            const thumb = await this.downloadThumb(file);

            this.thumbnailCache
                ?.put(file.id.toString(), new Response(thumb))
                .catch((e) => {
                    log.error("thumb cache put failed", e);
                    // TODO: handle storage full exception.
                });
            return thumb;
        } catch (e) {
            log.error("getThumbnail failed", e);
            throw e;
        }
    }

    async getThumbnailForPreview(file: EnteFile, localOnly = false) {
        try {
            if (!this.ready) {
                throw Error(CustomError.DOWNLOAD_MANAGER_NOT_READY);
            }
            if (!this.thumbnailObjectURLPromises.has(file.id)) {
                const thumbPromise = this.getThumbnail(file, localOnly);
                const thumbURLPromise = thumbPromise.then(
                    (thumb) => thumb && URL.createObjectURL(new Blob([thumb])),
                );
                this.thumbnailObjectURLPromises.set(file.id, thumbURLPromise);
            }
            let thumb = await this.thumbnailObjectURLPromises.get(file.id);
            if (!thumb && !localOnly) {
                this.thumbnailObjectURLPromises.delete(file.id);
                thumb = await this.getThumbnailForPreview(file, localOnly);
            }
            return thumb;
        } catch (e) {
            this.thumbnailObjectURLPromises.delete(file.id);
            log.error("get DownloadManager preview Failed", e);
            throw e;
        }
    }

    getFileForPreview = async (
        file: EnteFile,
        forceConvert = false,
    ): Promise<SourceURLs> => {
        try {
            if (!this.ready) {
                throw Error(CustomError.DOWNLOAD_MANAGER_NOT_READY);
            }
            const getFileForPreviewPromise = async () => {
                const fileBlob = await new Response(
                    await this.getFile(file, true),
                ).blob();
                const { url: originalFileURL } =
                    await this.fileObjectURLPromises.get(file.id);

                const converted = await getRenderableFileURL(
                    file,
                    fileBlob,
                    originalFileURL as string,
                    forceConvert,
                );
                return converted;
            };
            if (forceConvert || !this.fileConversionPromises.has(file.id)) {
                this.fileConversionPromises.set(
                    file.id,
                    getFileForPreviewPromise(),
                );
            }
            const fileURLs = await this.fileConversionPromises.get(file.id);
            return fileURLs;
        } catch (e) {
            this.fileConversionPromises.delete(file.id);
            log.error("download manager getFileForPreview Failed", e);
            throw e;
        }
    };

    async getFile(
        file: EnteFile,
        cacheInMemory = false,
    ): Promise<ReadableStream<Uint8Array>> {
        try {
            if (!this.ready) {
                throw Error(CustomError.DOWNLOAD_MANAGER_NOT_READY);
            }
            const getFilePromise = async (): Promise<SourceURLs> => {
                const fileStream = await this.downloadFile(file);
                const fileBlob = await new Response(fileStream).blob();
                return {
                    url: URL.createObjectURL(fileBlob),
                    isOriginal: true,
                    isRenderable: false,
                    type: "normal",
                };
            };
            if (!this.fileObjectURLPromises.has(file.id)) {
                if (!cacheInMemory) {
                    return await this.downloadFile(file);
                }
                this.fileObjectURLPromises.set(file.id, getFilePromise());
            }
            const fileURLs = await this.fileObjectURLPromises.get(file.id);
            if (fileURLs.isOriginal) {
                const fileStream = (await fetch(fileURLs.url as string)).body;
                return fileStream;
            } else {
                return await this.downloadFile(file);
            }
        } catch (e) {
            this.fileObjectURLPromises.delete(file.id);
            log.error("download manager getFile Failed", e);
            throw e;
        }
    }

    private async downloadFile(
        file: EnteFile,
    ): Promise<ReadableStream<Uint8Array>> {
        try {
            log.info(`download attempted for fileID:${file.id}`);
            const onDownloadProgress = this.trackDownloadProgress(
                file.id,
                file.info?.fileSize,
            );
            if (
                file.metadata.fileType === FILE_TYPE.IMAGE ||
                file.metadata.fileType === FILE_TYPE.LIVE_PHOTO
            ) {
                let encrypted = await this.getCachedFile(file);
                if (!encrypted) {
                    encrypted = new Response(
                        await this.downloadClient.downloadFile(
                            file,
                            onDownloadProgress,
                        ),
                    );
                    if (this.diskFileCache) {
                        this.diskFileCache
                            .put(file.id.toString(), encrypted.clone())
                            .catch((e) => {
                                log.error("file cache put failed", e);
                                // TODO: handle storage full exception.
                            });
                    }
                }
                this.clearDownloadProgress(file.id);
                try {
                    const decrypted = await this.cryptoWorker.decryptFile(
                        new Uint8Array(await encrypted.arrayBuffer()),
                        await this.cryptoWorker.fromB64(
                            file.file.decryptionHeader,
                        ),
                        file.key,
                    );
                    return generateStreamFromArrayBuffer(decrypted);
                } catch (e) {
                    if (e.message === CustomError.PROCESSING_FAILED) {
                        log.error(
                            `Failed to process file with fileID:${file.id}, localID: ${file.metadata.localID}, version: ${file.metadata.version}, deviceFolder:${file.metadata.deviceFolder}`,
                            e,
                        );
                    }
                    throw e;
                }
            }

            let resp: Response = await this.getCachedFile(file);
            if (!resp) {
                resp = await this.downloadClient.downloadFileStream(file);
                if (this.diskFileCache) {
                    this.diskFileCache
                        .put(file.id.toString(), resp.clone())
                        .catch((e) => {
                            log.error("file cache put failed", e);
                        });
                }
            }
            const reader = resp.body.getReader();

            const contentLength = +resp.headers.get("Content-Length") ?? 0;
            let downloadedBytes = 0;

            const stream = new ReadableStream({
                start: async (controller) => {
                    try {
                        const decryptionHeader =
                            await this.cryptoWorker.fromB64(
                                file.file.decryptionHeader,
                            );
                        const fileKey = await this.cryptoWorker.fromB64(
                            file.key,
                        );
                        const { pullState, decryptionChunkSize } =
                            await this.cryptoWorker.initChunkDecryption(
                                decryptionHeader,
                                fileKey,
                            );
                        let data = new Uint8Array();
                        // The following function handles each data chunk
                        const push = () => {
                            // "done" is a Boolean and value a "Uint8Array"
                            reader.read().then(async ({ done, value }) => {
                                try {
                                    // Is there more data to read?
                                    if (!done) {
                                        downloadedBytes += value.byteLength;
                                        onDownloadProgress({
                                            loaded: downloadedBytes,
                                            total: contentLength,
                                        });
                                        const buffer = new Uint8Array(
                                            data.byteLength + value.byteLength,
                                        );
                                        buffer.set(new Uint8Array(data), 0);
                                        buffer.set(
                                            new Uint8Array(value),
                                            data.byteLength,
                                        );
                                        if (
                                            buffer.length > decryptionChunkSize
                                        ) {
                                            const fileData = buffer.slice(
                                                0,
                                                decryptionChunkSize,
                                            );
                                            try {
                                                const { decryptedData } =
                                                    await this.cryptoWorker.decryptFileChunk(
                                                        fileData,
                                                        pullState,
                                                    );
                                                controller.enqueue(
                                                    decryptedData,
                                                );
                                                data =
                                                    buffer.slice(
                                                        decryptionChunkSize,
                                                    );
                                            } catch (e) {
                                                if (
                                                    e.message ===
                                                    CustomError.PROCESSING_FAILED
                                                ) {
                                                    log.error(
                                                        `Failed to process file ${file.id} from localID: ${file.metadata.localID} version: ${file.metadata.version} deviceFolder:${file.metadata.deviceFolder}`,
                                                        e,
                                                    );
                                                }
                                                throw e;
                                            }
                                        } else {
                                            data = buffer;
                                        }
                                        push();
                                    } else {
                                        if (data) {
                                            try {
                                                const { decryptedData } =
                                                    await this.cryptoWorker.decryptFileChunk(
                                                        data,
                                                        pullState,
                                                    );
                                                controller.enqueue(
                                                    decryptedData,
                                                );
                                                data = null;
                                            } catch (e) {
                                                if (
                                                    e.message ===
                                                    CustomError.PROCESSING_FAILED
                                                ) {
                                                    log.error(
                                                        `Failed to process file ${file.id} from localID: ${file.metadata.localID} version: ${file.metadata.version} deviceFolder:${file.metadata.deviceFolder}`,
                                                        e,
                                                    );
                                                }
                                                throw e;
                                            }
                                        }
                                        controller.close();
                                    }
                                } catch (e) {
                                    log.error(
                                        "Failed to process file chunk",
                                        e,
                                    );
                                    controller.error(e);
                                }
                            });
                        };

                        push();
                    } catch (e) {
                        log.error("Failed to process file stream", e);
                        controller.error(e);
                    }
                },
            });
            return stream;
        } catch (e) {
            log.error("Failed to download file", e);
            throw e;
        }
    }

    trackDownloadProgress = (fileID: number, fileSize: number) => {
        return (event: { loaded: number; total: number }) => {
            if (isNaN(event.total) || event.total === 0) {
                if (!fileSize) {
                    return;
                }
                event.total = fileSize;
            }
            if (event.loaded === event.total) {
                this.fileDownloadProgress.delete(fileID);
            } else {
                this.fileDownloadProgress.set(
                    fileID,
                    Math.round((event.loaded * 100) / event.total),
                );
            }
            this.progressUpdater(new Map(this.fileDownloadProgress));
        };
    };

    clearDownloadProgress = (fileID: number) => {
        this.fileDownloadProgress.delete(fileID);
        this.progressUpdater(new Map(this.fileDownloadProgress));
    };
}

const DownloadManager = new DownloadManagerImpl();

export default DownloadManager;

async function openThumbnailCache() {
    try {
        return await CacheStorageService.open("thumbs");
    } catch (e) {
        log.error("Failed to open thumbnail cache", e);
        if (isInternalUser()) {
            throw e;
        } else {
            return null;
        }
    }
}

async function openDiskFileCache() {
    try {
        if (!isElectron()) {
            throw Error(CustomError.NOT_AVAILABLE_ON_WEB);
        }
        return await CacheStorageService.open("files");
    } catch (e) {
        log.error("Failed to open file cache", e);
        if (isInternalUser()) {
            throw e;
        } else {
            return null;
        }
    }
}

function createDownloadClient(
    app: APPS,
    tokens?: { token: string; passwordToken?: string } | { token: string },
    timeout?: number,
): DownloadClient {
    if (!timeout) {
        timeout = 300000; // 5 minute
    }
    if (app === APPS.ALBUMS) {
        if (!tokens) {
            tokens = { token: undefined, passwordToken: undefined };
        }
        const { token, passwordToken } = tokens as {
            token: string;
            passwordToken: string;
        };
        return new PublicAlbumsDownloadClient(token, passwordToken, timeout);
    } else {
        const { token } = tokens;
        return new PhotosDownloadClient(token, timeout);
    }
}
