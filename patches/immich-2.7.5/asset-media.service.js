"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssetMediaService = void 0;
const common_1 = require("@nestjs/common");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const sanitize_filename_1 = __importDefault(require("sanitize-filename"));
const storage_core_1 = require("../cores/storage.core");
const asset_media_response_dto_1 = require("../dtos/asset-media-response.dto");
const asset_media_dto_1 = require("../dtos/asset-media.dto");
const enum_1 = require("../enum");
const base_service_1 = require("./base.service");
const access_1 = require("../utils/access");
const asset_util_1 = require("../utils/asset.util");
const database_1 = require("../utils/database");
const file_1 = require("../utils/file");
const mime_types_1 = require("../utils/mime-types");
const request_1 = require("../utils/request");
let AssetMediaService = class AssetMediaService extends base_service_1.BaseService {
    async getUploadAssetIdByChecksum(auth, checksum) {
        if (!checksum) {
            return;
        }
        const assetId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, (0, request_1.fromChecksum)(checksum));
        if (!assetId) {
            return;
        }
        return { id: assetId, status: asset_media_response_dto_1.AssetMediaStatus.DUPLICATE };
    }
    canUploadFile({ auth, fieldName, file, body }) {
        (0, access_1.requireUploadAccess)(auth);
        const filename = body.filename || file.originalName;
        switch (fieldName) {
            case asset_media_dto_1.UploadFieldName.ASSET_DATA: {
                if (mime_types_1.mimeTypes.isAsset(filename)) {
                    return true;
                }
                break;
            }
            case asset_media_dto_1.UploadFieldName.SIDECAR_DATA: {
                if (mime_types_1.mimeTypes.isSidecar(filename)) {
                    return true;
                }
                break;
            }
            case asset_media_dto_1.UploadFieldName.PROFILE_DATA: {
                if (mime_types_1.mimeTypes.isProfile(filename)) {
                    return true;
                }
                break;
            }
        }
        this.logger.error(`Unsupported file type ${filename}`);
        throw new common_1.BadRequestException(`Unsupported file type ${filename}`);
    }
    getUploadFilename({ auth, fieldName, file, body }) {
        (0, access_1.requireUploadAccess)(auth);
        const extension = (0, node_path_1.extname)(body.filename || file.originalName);
        const lookup = {
            [asset_media_dto_1.UploadFieldName.ASSET_DATA]: extension,
            [asset_media_dto_1.UploadFieldName.SIDECAR_DATA]: '.xmp',
            [asset_media_dto_1.UploadFieldName.PROFILE_DATA]: extension,
        };
        return (0, sanitize_filename_1.default)(`${file.uuid}${lookup[fieldName]}`);
    }
    getUploadFolder({ auth, fieldName, file }) {
        auth = (0, access_1.requireUploadAccess)(auth);
        let folder = storage_core_1.StorageCore.getNestedFolder(enum_1.StorageFolder.Upload, auth.user.id, file.uuid);
        if (fieldName === asset_media_dto_1.UploadFieldName.PROFILE_DATA) {
            folder = storage_core_1.StorageCore.getFolderLocation(enum_1.StorageFolder.Profile, auth.user.id);
        }
        this.storageRepository.mkdirSync(folder);
        return folder;
    }
    async onUploadError(request, file) {
        const uploadFilename = this.getUploadFilename((0, asset_util_1.asUploadRequest)(request, file));
        const uploadFolder = this.getUploadFolder((0, asset_util_1.asUploadRequest)(request, file));
        const uploadPath = `${uploadFolder}/${uploadFilename}`;
        await this.jobRepository.queue({ name: enum_1.JobName.FileDelete, data: { files: [uploadPath] } });
    }
    async uploadAsset(auth, dto, file, sidecarFile) {
        try {
            await this.requireAccess({
                auth,
                permission: enum_1.Permission.AssetUpload,
                ids: [auth.user.id],
            });
            this.requireQuota(auth, file.size);
            if (dto.livePhotoVideoId) {
                await (0, asset_util_1.onBeforeLink)({ asset: this.assetRepository, event: this.eventRepository }, { userId: auth.user.id, livePhotoVideoId: dto.livePhotoVideoId });
            }
            const asset = await this.create(auth.user.id, dto, file, sidecarFile);
            if (auth.sharedLink) {
                await this.addToSharedLink(auth.sharedLink, asset.id);
            }
            await this.userRepository.updateUsage(auth.user.id, file.size);
            return { id: asset.id, status: asset_media_response_dto_1.AssetMediaStatus.CREATED };
        }
        catch (error) {
            return this.handleUploadError(error, auth, file, sidecarFile);
        }
    }
    async replaceAsset(auth, id, dto, file, sidecarFile) {
        try {
            await this.requireAccess({ auth, permission: enum_1.Permission.AssetUpdate, ids: [id] });
            const asset = await this.assetRepository.getById(id);
            if (!asset) {
                throw new Error('Asset not found');
            }
            this.requireQuota(auth, file.size);
            await this.replaceFileData(asset.id, dto, file, sidecarFile?.originalPath);
            const copiedPhoto = await this.createCopy(asset);
            await this.assetRepository.updateAll([copiedPhoto.id], { deletedAt: new Date(), status: enum_1.AssetStatus.Trashed });
            await this.eventRepository.emit('AssetTrash', { assetId: copiedPhoto.id, userId: auth.user.id });
            await this.userRepository.updateUsage(auth.user.id, file.size);
            return { status: asset_media_response_dto_1.AssetMediaStatus.REPLACED, id: copiedPhoto.id };
        }
        catch (error) {
            return this.handleUploadError(error, auth, file, sidecarFile);
        }
    }
    async downloadOriginal(auth, id, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.AssetDownload, ids: [id] });
        if (auth.sharedLink) {
            dto.edited = true;
        }
        const { originalPath, originalFileName, editedPath } = await this.assetRepository.getForOriginal(id, dto.edited ?? false);
        const path = editedPath ?? originalPath;
        return new file_1.ImmichFileResponse({
            path,
            fileName: (0, file_1.getFileNameWithoutExtension)(originalFileName) + (0, file_1.getFilenameExtension)(path),
            contentType: mime_types_1.mimeTypes.lookup(path),
            cacheControl: enum_1.CacheControl.PrivateWithCache,
        });
    }
    async viewThumbnail(auth, id, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.AssetView, ids: [id] });
        if (dto.size === asset_media_dto_1.AssetMediaSize.Original) {
            throw new common_1.BadRequestException('May not request original file');
        }
        if (auth.sharedLink) {
            dto.edited = true;
        }
        const size = (dto.size ?? asset_media_dto_1.AssetMediaSize.THUMBNAIL);
        const { originalPath, originalFileName, path } = await this.assetRepository.getForThumbnail(id, size, dto.edited ?? false);
        if (size === asset_media_dto_1.AssetMediaSize.PREVIEW && mime_types_1.mimeTypes.isWebSupportedImage(originalPath) && !auth.sharedLink) {
            return new file_1.ImmichFileResponse({
                fileName: originalFileName,
                path: originalPath,
                contentType: mime_types_1.mimeTypes.lookup(originalPath),
                cacheControl: enum_1.CacheControl.PrivateWithCache,
            });
        }
        if (size === asset_media_dto_1.AssetMediaSize.THUMBNAIL && path?.startsWith('/data/thumbs/')) {
            const ssdThumbnailPath = path.replace('/data/thumbs/', '/thumbnail-cache/');
            if ((0, node_fs_1.existsSync)(ssdThumbnailPath)) {
                return new file_1.ImmichFileResponse({
                    fileName: `${auth.sharedLink && !auth.sharedLink.showExif ? id : (0, file_1.getFileNameWithoutExtension)(originalFileName)}_${size}${(0, file_1.getFilenameExtension)(ssdThumbnailPath)}`,
                    path: ssdThumbnailPath,
                    contentType: mime_types_1.mimeTypes.lookup(ssdThumbnailPath),
                    cacheControl: enum_1.CacheControl.PrivateWithCache,
                });
            }
        }
        if (size === enum_1.AssetFileType.FullSize && mime_types_1.mimeTypes.isWebSupportedImage(originalPath) && !dto.edited) {
            return { targetSize: 'original' };
        }
        if (dto.size === asset_media_dto_1.AssetMediaSize.FULLSIZE && !path) {
            return { targetSize: asset_media_dto_1.AssetMediaSize.PREVIEW };
        }
        if (!path) {
            throw new common_1.NotFoundException('Asset media not found');
        }
        const fileNameBase = auth.sharedLink && !auth.sharedLink.showExif ? id : (0, file_1.getFileNameWithoutExtension)(originalFileName);
        const fileName = `${fileNameBase}_${size}${(0, file_1.getFilenameExtension)(path)}`;
        return new file_1.ImmichFileResponse({
            fileName,
            path,
            contentType: mime_types_1.mimeTypes.lookup(path),
            cacheControl: enum_1.CacheControl.PrivateWithCache,
        });
    }
    async playbackVideo(auth, id) {
        await this.requireAccess({ auth, permission: enum_1.Permission.AssetView, ids: [id] });
        const asset = await this.assetRepository.getForVideo(id);
        if (!asset) {
            throw new common_1.NotFoundException('Asset not found or asset is not a video');
        }
        const filepath = asset.encodedVideoPath || asset.originalPath;
        return new file_1.ImmichFileResponse({
            path: filepath,
            contentType: mime_types_1.mimeTypes.lookup(filepath),
            cacheControl: enum_1.CacheControl.PrivateWithCache,
        });
    }
    async checkExistingAssets(auth, checkExistingAssetsDto) {
        const existingIds = await this.assetRepository.getByDeviceIds(auth.user.id, checkExistingAssetsDto.deviceId, checkExistingAssetsDto.deviceAssetIds);
        return { existingIds };
    }
    async bulkUploadCheck(auth, dto) {
        const checksums = dto.assets.map((asset) => (0, request_1.fromChecksum)(asset.checksum));
        const results = await this.assetRepository.getByChecksums(auth.user.id, checksums);
        const checksumMap = {};
        for (const { id, deletedAt, checksum } of results) {
            checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
        }
        return {
            results: dto.assets.map(({ id, checksum }) => {
                const duplicate = checksumMap[(0, request_1.fromChecksum)(checksum).toString('hex')];
                if (duplicate) {
                    return {
                        id,
                        action: asset_media_response_dto_1.AssetUploadAction.REJECT,
                        reason: asset_media_response_dto_1.AssetRejectReason.DUPLICATE,
                        assetId: duplicate.id,
                        isTrashed: duplicate.isTrashed,
                    };
                }
                return {
                    id,
                    action: asset_media_response_dto_1.AssetUploadAction.ACCEPT,
                };
            }),
        };
    }
    async addToSharedLink(sharedLink, assetId) {
        await (sharedLink.albumId
            ? this.albumRepository.addAssetIds(sharedLink.albumId, [assetId])
            : this.sharedLinkRepository.addAssets(sharedLink.id, [assetId]));
    }
    async handleUploadError(error, auth, file, sidecarFile) {
        await this.jobRepository.queue({
            name: enum_1.JobName.FileDelete,
            data: { files: [file.originalPath, sidecarFile?.originalPath] },
        });
        if ((0, database_1.isAssetChecksumConstraint)(error)) {
            const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
            if (!duplicateId) {
                this.logger.error(`Error locating duplicate for checksum constraint`);
                throw new common_1.InternalServerErrorException();
            }
            if (auth.sharedLink) {
                await this.addToSharedLink(auth.sharedLink, duplicateId);
            }
            this.logger.debug(`Duplicate asset upload rejected: existing asset ${duplicateId}`);
            return { status: asset_media_response_dto_1.AssetMediaStatus.DUPLICATE, id: duplicateId };
        }
        this.logger.error(`Error uploading file ${error}`, error?.stack);
        throw error;
    }
    async replaceFileData(assetId, dto, file, sidecarPath) {
        await this.assetRepository.update({
            id: assetId,
            checksum: file.checksum,
            originalPath: file.originalPath,
            type: mime_types_1.mimeTypes.assetType(file.originalPath),
            originalFileName: file.originalName,
            deviceAssetId: dto.deviceAssetId,
            deviceId: dto.deviceId,
            fileCreatedAt: dto.fileCreatedAt,
            fileModifiedAt: dto.fileModifiedAt,
            localDateTime: dto.fileCreatedAt,
            duration: dto.duration || null,
            livePhotoVideoId: null,
        });
        await (sidecarPath
            ? this.assetRepository.upsertFile({ assetId, type: enum_1.AssetFileType.Sidecar, path: sidecarPath })
            : this.assetRepository.deleteFile({ assetId, type: enum_1.AssetFileType.Sidecar }));
        await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
        await this.assetRepository.upsertExif({ assetId, fileSizeInByte: file.size }, { lockedPropertiesBehavior: 'override' });
        await this.jobRepository.queue({
            name: enum_1.JobName.AssetExtractMetadata,
            data: { id: assetId, source: 'upload' },
        });
    }
    async createCopy(asset) {
        const created = await this.assetRepository.create({
            ownerId: asset.ownerId,
            originalPath: asset.originalPath,
            originalFileName: asset.originalFileName,
            libraryId: asset.libraryId,
            deviceAssetId: asset.deviceAssetId,
            deviceId: asset.deviceId,
            type: asset.type,
            checksum: asset.checksum,
            checksumAlgorithm: asset.checksumAlgorithm,
            fileCreatedAt: asset.fileCreatedAt,
            localDateTime: asset.localDateTime,
            fileModifiedAt: asset.fileModifiedAt,
            livePhotoVideoId: asset.livePhotoVideoId,
        });
        const { size } = await this.storageRepository.stat(created.originalPath);
        await this.assetRepository.upsertExif({ assetId: created.id, fileSizeInByte: size }, { lockedPropertiesBehavior: 'override' });
        await this.jobRepository.queue({ name: enum_1.JobName.AssetExtractMetadata, data: { id: created.id, source: 'copy' } });
        return created;
    }
    async create(ownerId, dto, file, sidecarFile) {
        const asset = await this.assetRepository.create({
            ownerId,
            libraryId: null,
            checksum: file.checksum,
            checksumAlgorithm: enum_1.ChecksumAlgorithm.sha1File,
            originalPath: file.originalPath,
            deviceAssetId: dto.deviceAssetId,
            deviceId: dto.deviceId,
            fileCreatedAt: dto.fileCreatedAt,
            fileModifiedAt: dto.fileModifiedAt,
            localDateTime: dto.fileCreatedAt,
            type: mime_types_1.mimeTypes.assetType(file.originalPath),
            isFavorite: dto.isFavorite,
            duration: dto.duration || null,
            visibility: dto.visibility ?? enum_1.AssetVisibility.Timeline,
            livePhotoVideoId: dto.livePhotoVideoId,
            originalFileName: dto.filename || file.originalName,
        });
        if (dto.metadata?.length) {
            await this.assetRepository.upsertMetadata(asset.id, dto.metadata);
        }
        if (sidecarFile) {
            await this.assetRepository.upsertFile({
                assetId: asset.id,
                path: sidecarFile.originalPath,
                type: enum_1.AssetFileType.Sidecar,
            });
            await this.storageRepository.utimes(sidecarFile.originalPath, new Date(), new Date(dto.fileModifiedAt));
        }
        await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
        await this.assetRepository.upsertExif({ assetId: asset.id, fileSizeInByte: file.size }, { lockedPropertiesBehavior: 'override' });
        await this.eventRepository.emit('AssetCreate', { asset });
        await this.jobRepository.queue({ name: enum_1.JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });
        return asset;
    }
    requireQuota(auth, size) {
        if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
            throw new common_1.BadRequestException('Quota has been exceeded!');
        }
    }
};
exports.AssetMediaService = AssetMediaService;
exports.AssetMediaService = AssetMediaService = __decorate([
    (0, common_1.Injectable)()
], AssetMediaService);
//# sourceMappingURL=asset-media.service.js.map
