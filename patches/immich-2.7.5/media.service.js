"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaService = void 0;
const common_1 = require("@nestjs/common");
const node_fs_1 = require("node:fs");
const constants_1 = require("../constants");
const storage_core_1 = require("../cores/storage.core");
const decorators_1 = require("../decorators");
const editing_dto_1 = require("../dtos/editing.dto");
const enum_1 = require("../enum");
const base_service_1 = require("./base.service");
const asset_util_1 = require("../utils/asset.util");
const editor_1 = require("../utils/editor");
const media_1 = require("../utils/media");
const mime_types_1 = require("../utils/mime-types");
const misc_1 = require("../utils/misc");
const transform_1 = require("../utils/transform");
let MediaService = class MediaService extends base_service_1.BaseService {
    videoInterfaces = { dri: [], mali: false };
    async onBootstrap() {
        const [dri, mali] = await Promise.all([this.getDevices(), this.hasMaliOpenCL()]);
        this.videoInterfaces = { dri, mali };
    }
    async handleQueueGenerateThumbnails({ force }) {
        const config = await this.getConfig({ withCache: true });
        let jobs = [];
        const queueAll = async () => {
            await this.jobRepository.queueAll(jobs);
            jobs = [];
        };
        const fullsizeEnabled = config.image.fullsize.enabled;
        for await (const asset of this.assetJobRepository.streamForThumbnailJob({ force, fullsizeEnabled })) {
            if (force || !asset.isEdited) {
                jobs.push({ name: enum_1.JobName.AssetGenerateThumbnails, data: { id: asset.id } });
            }
            if (asset.isEdited) {
                jobs.push({ name: enum_1.JobName.AssetEditThumbnailGeneration, data: { id: asset.id } });
            }
            if (jobs.length >= constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await queueAll();
            }
        }
        await queueAll();
        const people = this.personRepository.getAll(force ? undefined : { thumbnailPath: '' });
        for await (const person of people) {
            if (!person.faceAssetId) {
                const face = await this.personRepository.getRandomFace(person.id);
                if (!face) {
                    continue;
                }
                await this.personRepository.update({ id: person.id, faceAssetId: face.id });
            }
            jobs.push({ name: enum_1.JobName.PersonGenerateThumbnail, data: { id: person.id } });
            if (jobs.length >= constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await queueAll();
            }
        }
        await queueAll();
        return enum_1.JobStatus.Success;
    }
    async handleQueueMigration() {
        const { active, waiting } = await this.jobRepository.getJobCounts(enum_1.QueueName.Migration);
        if (active === 1 && waiting === 0) {
            await this.storageCore.removeEmptyDirs(enum_1.StorageFolder.Thumbnails);
            await this.storageCore.removeEmptyDirs(enum_1.StorageFolder.EncodedVideo);
        }
        let jobs = [];
        const assets = this.assetJobRepository.streamForMigrationJob();
        for await (const asset of assets) {
            jobs.push({ name: enum_1.JobName.AssetFileMigration, data: { id: asset.id } });
            if (jobs.length >= constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await this.jobRepository.queueAll(jobs);
                jobs = [];
            }
        }
        await this.jobRepository.queueAll(jobs);
        jobs = [];
        for await (const person of this.personRepository.getAll()) {
            jobs.push({ name: enum_1.JobName.PersonFileMigration, data: { id: person.id } });
            if (jobs.length === constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await this.jobRepository.queueAll(jobs);
                jobs = [];
            }
        }
        await this.jobRepository.queueAll(jobs);
        return enum_1.JobStatus.Success;
    }
    async handleAssetMigration({ id }) {
        const { image } = await this.getConfig({ withCache: true });
        const asset = await this.assetJobRepository.getForMigrationJob(id);
        if (!asset) {
            return enum_1.JobStatus.Failed;
        }
        await this.storageCore.moveAssetImage(asset, enum_1.AssetFileType.FullSize, image.fullsize.format);
        await this.storageCore.moveAssetImage(asset, enum_1.AssetFileType.Thumbnail, image.thumbnail.format);
        await this.storageCore.moveAssetVideo(asset);
        return enum_1.JobStatus.Success;
    }
    async handleAssetEditThumbnailGeneration({ id }) {
        const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
        const config = await this.getConfig({ withCache: true });
        if (!asset) {
            this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
            return enum_1.JobStatus.Failed;
        }
        const generated = await this.generateEditedThumbnails(asset, config);
        await this.syncFiles(asset.files.filter((file) => file.isEdited), generated?.files ?? []);
        let thumbhash = generated?.thumbhash;
        if (!thumbhash) {
            const extractedImage = await this.extractOriginalImage(asset, config.image);
            const { info, data, colorspace } = extractedImage;
            thumbhash = await this.mediaRepository.generateThumbhash(data, {
                colorspace,
                processInvalidImages: false,
                raw: info,
                edits: [],
            });
        }
        if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
            await this.assetRepository.update({ id: asset.id, thumbhash });
        }
        const fullsizeDimensions = generated?.fullsizeDimensions ?? (0, asset_util_1.getDimensions)(asset.exifInfo);
        await this.assetRepository.update({ id: asset.id, ...fullsizeDimensions });
        return enum_1.JobStatus.Success;
    }
    async handleGenerateThumbnails({ id }) {
        const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
        const config = await this.getConfig({ withCache: true });
        if (!asset) {
            this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
            return enum_1.JobStatus.Failed;
        }
        if (asset.visibility === enum_1.AssetVisibility.Hidden) {
            this.logger.verbose(`Thumbnail generation skipped for asset ${id}: not visible`);
            return enum_1.JobStatus.Skipped;
        }
        let generated;
        if (asset.type === enum_1.AssetType.Video || asset.originalFileName.toLowerCase().endsWith('.gif')) {
            this.logger.verbose(`Thumbnail generation for video ${id} ${asset.originalPath}`);
            generated = await this.generateVideoThumbnails(asset, config);
        }
        else if (asset.type === enum_1.AssetType.Image) {
            this.logger.verbose(`Thumbnail generation for image ${id} ${asset.originalPath}`);
            generated = await this.generateImageThumbnails(asset, config);
        }
        else {
            this.logger.warn(`Skipping thumbnail generation for asset ${id}: ${asset.type} is not an image or video`);
            return enum_1.JobStatus.Skipped;
        }
        const editedGenerated = await this.generateEditedThumbnails(asset, config);
        if (editedGenerated) {
            generated.files.push(...editedGenerated.files);
        }
        await this.syncFiles(asset.files, generated.files);
        const thumbhash = editedGenerated?.thumbhash || generated.thumbhash;
        if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
            await this.assetRepository.update({ id: asset.id, thumbhash });
        }
        return enum_1.JobStatus.Success;
    }
    async extractImage(originalPath, minSize) {
        let extracted = await this.mediaRepository.extract(originalPath);
        if (extracted && !(await this.shouldUseExtractedImage(extracted.buffer, minSize))) {
            extracted = null;
        }
        return extracted;
    }
    async decodeImage(thumbSource, exifInfo, targetSize) {
        const { image } = await this.getConfig({ withCache: true });
        const colorspace = this.isSRGB(exifInfo) ? enum_1.Colorspace.Srgb : image.colorspace;
        const decodeOptions = {
            colorspace,
            processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
            size: targetSize,
            orientation: exifInfo.orientation ? Number(exifInfo.orientation) : undefined,
        };
        const { info, data } = await this.mediaRepository.decodeImage(thumbSource, decodeOptions);
        return { info, data, colorspace };
    }
    async extractOriginalImage(asset, image, useEdits = false) {
        const extractEmbedded = image.extractEmbedded && mime_types_1.mimeTypes.isRaw(asset.originalFileName);
        const extracted = extractEmbedded ? await this.extractImage(asset.originalPath, image.preview.size) : null;
        const generateFullsize = ((image.fullsize.enabled || asset.exifInfo.projectionType === 'EQUIRECTANGULAR') &&
            !mime_types_1.mimeTypes.isWebSupportedImage(asset.originalPath)) ||
            useEdits;
        const convertFullsize = generateFullsize && (!extracted || !mime_types_1.mimeTypes.isWebSupportedImage(` .${extracted.format}`));
        const thumbSource = extracted ? extracted.buffer : asset.originalPath;
        const { data, info, colorspace } = await this.decodeImage(thumbSource, extracted ? asset.exifInfo : { ...asset.exifInfo, orientation: null }, convertFullsize ? undefined : image.preview.size);
        let isTransparent = false;
        if (!extracted && mime_types_1.mimeTypes.canBeTransparent(asset.originalPath)) {
            ({ isTransparent } = await this.mediaRepository.getImageMetadata(asset.originalPath));
        }
        return {
            extracted,
            data,
            info,
            colorspace,
            convertFullsize,
            generateFullsize,
            isTransparent,
        };
    }
    async generateImageThumbnails(asset, { image }, useEdits = false) {
        const extractedImage = await this.extractOriginalImage(asset, image, useEdits);
        const { info, data, colorspace, generateFullsize, convertFullsize, extracted, isTransparent } = extractedImage;
        const thumbnailFormat = image.thumbnail.format;
        this.warnOnTransparencyLoss(isTransparent, thumbnailFormat, asset.id);
        const thumbnailFile = this.getImageFile(asset, {
            fileType: enum_1.AssetFileType.Thumbnail,
            format: thumbnailFormat,
            isEdited: useEdits,
            isProgressive: !!image.thumbnail.progressive && thumbnailFormat !== enum_1.ImageFormat.Webp,
            isTransparent,
        });
        this.storageCore.ensureFolders(thumbnailFile.path);
        const baseOptions = { colorspace, processInvalidImages: false, raw: info, edits: useEdits ? asset.edits : [] };
        const thumbnailOptions = { ...image.thumbnail, ...baseOptions, format: thumbnailFormat };
        const promises = [
            this.mediaRepository.generateThumbhash(data, baseOptions),
            this.mediaRepository.generateThumbnail(data, thumbnailOptions, thumbnailFile.path),
        ];
        let fullsizeFile;
        if (convertFullsize) {
            const fullsizeFormat = image.fullsize.format;
            this.warnOnTransparencyLoss(isTransparent, fullsizeFormat, asset.id);
            fullsizeFile = this.getImageFile(asset, {
                fileType: enum_1.AssetFileType.FullSize,
                format: fullsizeFormat,
                isEdited: useEdits,
                isProgressive: !!image.fullsize.progressive && fullsizeFormat !== enum_1.ImageFormat.Webp,
                isTransparent,
            });
            const fullsizeOptions = {
                ...baseOptions,
                format: fullsizeFormat,
                quality: image.fullsize.quality,
                progressive: image.fullsize.progressive,
            };
            promises.push(this.mediaRepository.generateThumbnail(data, fullsizeOptions, fullsizeFile.path));
        }
        else if (generateFullsize && extracted && extracted.format === enum_1.RawExtractedFormat.Jpeg) {
            fullsizeFile = this.getImageFile(asset, {
                fileType: enum_1.AssetFileType.FullSize,
                format: extracted.format,
                isEdited: false,
                isProgressive: !!image.fullsize.progressive && image.fullsize.format !== enum_1.ImageFormat.Webp,
                isTransparent,
            });
            this.storageCore.ensureFolders(fullsizeFile.path);
            await this.storageRepository.createOrOverwriteFile(fullsizeFile.path, extracted.buffer);
            await this.mediaRepository.writeExif({
                orientation: asset.exifInfo.orientation,
                colorspace: asset.exifInfo.colorspace,
            }, fullsizeFile.path);
        }
        const outputs = await Promise.all(promises);
        if (asset.exifInfo.projectionType === 'EQUIRECTANGULAR') {
            const promises = [
                fullsizeFile
                    ? this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, fullsizeFile.path)
                    : Promise.resolve(),
            ];
            await Promise.all(promises);
        }
        const decodedDimensions = { width: info.width, height: info.height };
        const fullsizeDimensions = useEdits ? (0, transform_1.getOutputDimensions)(asset.edits, decodedDimensions) : decodedDimensions;
        return {
            files: fullsizeFile ? [thumbnailFile, fullsizeFile] : [thumbnailFile],
            thumbhash: outputs[0],
            fullsizeDimensions,
        };
    }
    async handleGeneratePersonThumbnail({ id }) {
        const { machineLearning, metadata, image } = await this.getConfig({ withCache: true });
        if (!(0, misc_1.isFacialRecognitionEnabled)(machineLearning) && !(0, misc_1.isFaceImportEnabled)(metadata)) {
            return enum_1.JobStatus.Skipped;
        }
        const data = await this.personRepository.getDataForThumbnailGenerationJob(id);
        if (!data) {
            this.logger.error(`Could not generate person thumbnail for ${id}: missing data`);
            return enum_1.JobStatus.Failed;
        }
        const { ownerId, x1, y1, x2, y2, oldWidth, oldHeight, exifOrientation, previewPath, originalPath } = data;
        let inputImage;
        if (data.type === enum_1.AssetType.Video) {
            if (!previewPath) {
                this.logger.error(`Could not generate person thumbnail for video ${id}: missing preview path`);
                return enum_1.JobStatus.Failed;
            }
            const cachedThumbnailPath = previewPath.replace('/data/thumbs/', '/thumbnail-cache/');
            inputImage = (0, node_fs_1.existsSync)(cachedThumbnailPath) ? cachedThumbnailPath : previewPath;
        }
        else if (image.extractEmbedded && mime_types_1.mimeTypes.isRaw(originalPath)) {
            const extracted = await this.extractImage(originalPath, image.preview.size);
            inputImage = extracted ? extracted.buffer : originalPath;
        }
        else {
            inputImage = originalPath;
        }
        const { data: decodedImage, info } = await this.mediaRepository.decodeImage(inputImage, {
            colorspace: image.colorspace,
            processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
            orientation: Buffer.isBuffer(inputImage) && exifOrientation ? Number(exifOrientation) : undefined,
        });
        const thumbnailPath = storage_core_1.StorageCore.getPersonThumbnailPath({ id, ownerId });
        this.storageCore.ensureFolders(thumbnailPath);
        const thumbnailOptions = {
            colorspace: image.colorspace,
            format: enum_1.ImageFormat.Jpeg,
            raw: info,
            quality: image.thumbnail.quality,
            progressive: false,
            processInvalidImages: false,
            size: constants_1.FACE_THUMBNAIL_SIZE,
            edits: [
                {
                    action: editing_dto_1.AssetEditAction.Crop,
                    parameters: this.getCrop({ old: { width: oldWidth, height: oldHeight }, new: { width: info.width, height: info.height } }, { x1, y1, x2, y2 }),
                },
            ],
        };
        await this.mediaRepository.generateThumbnail(decodedImage, thumbnailOptions, thumbnailPath);
        await this.personRepository.update({ id, thumbnailPath });
        return enum_1.JobStatus.Success;
    }
    getCrop(dims, { x1, y1, x2, y2 }) {
        const clampedX1 = (0, misc_1.clamp)(x1, 0, dims.old.width);
        const clampedY1 = (0, misc_1.clamp)(y1, 0, dims.old.height);
        const clampedX2 = (0, misc_1.clamp)(x2, 0, dims.old.width);
        const clampedY2 = (0, misc_1.clamp)(y2, 0, dims.old.height);
        const widthScale = dims.new.width / dims.old.width;
        const heightScale = dims.new.height / dims.old.height;
        const halfWidth = (widthScale * (clampedX2 - clampedX1)) / 2;
        const halfHeight = (heightScale * (clampedY2 - clampedY1)) / 2;
        const middleX = Math.round(widthScale * clampedX1 + halfWidth);
        const middleY = Math.round(heightScale * clampedY1 + halfHeight);
        const targetHalfSize = Math.floor(Math.max(halfWidth, halfHeight) * 1.1);
        const newHalfSize = Math.min(middleX - Math.max(0, middleX - targetHalfSize), middleY - Math.max(0, middleY - targetHalfSize), Math.min(dims.new.width - 1, middleX + targetHalfSize) - middleX, Math.min(dims.new.height - 1, middleY + targetHalfSize) - middleY);
        return {
            x: middleX - newHalfSize,
            y: middleY - newHalfSize,
            width: newHalfSize * 2,
            height: newHalfSize * 2,
        };
    }
    async generateVideoThumbnails(asset, { ffmpeg, image }) {
        const thumbnailFile = this.getImageFile(asset, {
            fileType: enum_1.AssetFileType.Thumbnail,
            format: image.thumbnail.format,
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
        });
        this.storageCore.ensureFolders(thumbnailFile.path);
        const { format, audioStreams, videoStreams } = await this.mediaRepository.probe(asset.originalPath);
        const mainVideoStream = this.getMainStream(videoStreams);
        if (!mainVideoStream) {
            throw new Error(`No video streams found for asset ${asset.id}`);
        }
        const mainAudioStream = this.getMainStream(audioStreams);
        const thumbnailConfig = media_1.ThumbnailConfig.create({ ...ffmpeg, targetResolution: image.thumbnail.size.toString() });
        const thumbnailOptions = thumbnailConfig.getCommand(enum_1.TranscodeTarget.Video, mainVideoStream, mainAudioStream, format);
        await this.mediaRepository.transcode(asset.originalPath, thumbnailFile.path, thumbnailOptions);
        const thumbhash = await this.mediaRepository.generateThumbhash(thumbnailFile.path, {
            colorspace: image.colorspace,
            processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
        });
        return {
            files: [thumbnailFile],
            thumbhash,
            fullsizeDimensions: { width: mainVideoStream.width, height: mainVideoStream.height },
        };
    }
    async handleQueueVideoConversion(job) {
        this.logger.log('Video encoding is disabled by local patch; no video conversion jobs will be queued.');
        return enum_1.JobStatus.Success;
    }
    async handleVideoConversion({ id }) {
        this.logger.log(`Video encoding is disabled by local patch; skipped asset ${id}.`);
        return enum_1.JobStatus.Skipped;
    }
    getMainStream(streams) {
        return streams
            .filter((stream) => stream.codecName !== 'unknown')
            .toSorted((stream1, stream2) => stream2.bitrate - stream1.bitrate)[0];
    }
    getTranscodeTarget(config, videoStream, audioStream) {
        const isAudioTranscodeRequired = this.isAudioTranscodeRequired(config, audioStream);
        const isVideoTranscodeRequired = this.isVideoTranscodeRequired(config, videoStream);
        if (isAudioTranscodeRequired && isVideoTranscodeRequired) {
            return enum_1.TranscodeTarget.All;
        }
        if (isAudioTranscodeRequired) {
            return enum_1.TranscodeTarget.Audio;
        }
        if (isVideoTranscodeRequired) {
            return enum_1.TranscodeTarget.Video;
        }
        return enum_1.TranscodeTarget.None;
    }
    isAudioTranscodeRequired(ffmpegConfig, stream) {
        if (!stream) {
            return false;
        }
        switch (ffmpegConfig.transcode) {
            case enum_1.TranscodePolicy.Disabled: {
                return false;
            }
            case enum_1.TranscodePolicy.All: {
                return true;
            }
            case enum_1.TranscodePolicy.Required:
            case enum_1.TranscodePolicy.Optimal:
            case enum_1.TranscodePolicy.Bitrate: {
                return !ffmpegConfig.acceptedAudioCodecs.includes(stream.codecName);
            }
            default: {
                throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
            }
        }
    }
    isVideoTranscodeRequired(ffmpegConfig, stream) {
        const scalingEnabled = ffmpegConfig.targetResolution !== 'original';
        const targetRes = Number.parseInt(ffmpegConfig.targetResolution);
        const isLargerThanTargetRes = scalingEnabled && Math.min(stream.height, stream.width) > targetRes;
        const maxBitrate = this.parseBitrateToBps(ffmpegConfig.maxBitrate);
        const isLargerThanTargetBitrate = maxBitrate > 0 && stream.bitrate > maxBitrate;
        const isTargetVideoCodec = ffmpegConfig.acceptedVideoCodecs.includes(stream.codecName);
        const isRequired = !isTargetVideoCodec || !stream.pixelFormat.endsWith('420p');
        switch (ffmpegConfig.transcode) {
            case enum_1.TranscodePolicy.Disabled: {
                return false;
            }
            case enum_1.TranscodePolicy.All: {
                return true;
            }
            case enum_1.TranscodePolicy.Required: {
                return isRequired;
            }
            case enum_1.TranscodePolicy.Optimal: {
                return isRequired || isLargerThanTargetRes;
            }
            case enum_1.TranscodePolicy.Bitrate: {
                return isRequired || isLargerThanTargetBitrate;
            }
            default: {
                throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
            }
        }
    }
    isRemuxRequired(ffmpegConfig, { formatName, formatLongName }) {
        if (ffmpegConfig.transcode === enum_1.TranscodePolicy.Disabled) {
            return false;
        }
        const formatLongNameMapping = {
            'QuickTime / MOV': enum_1.VideoContainer.Mov,
            'Matroska / WebM': enum_1.VideoContainer.Webm,
        };
        const name = (formatLongName ? formatLongNameMapping[formatLongName] : undefined) ?? formatName;
        return name !== enum_1.VideoContainer.Mp4 && !ffmpegConfig.acceptedContainers.includes(name);
    }
    isSRGB({ colorspace, profileDescription, bitsPerSample, }) {
        if (colorspace || profileDescription) {
            return [colorspace, profileDescription].some((s) => s?.toLowerCase().includes('srgb'));
        }
        else if (bitsPerSample) {
            return bitsPerSample === 8;
        }
        else {
            return true;
        }
    }
    parseBitrateToBps(bitrateString) {
        const bitrateValue = Number.parseInt(bitrateString);
        if (Number.isNaN(bitrateValue)) {
            this.logger.log(`Maximum bitrate '${bitrateString} is not a number and will be ignored.`);
            return 0;
        }
        if (bitrateString.toLowerCase().endsWith('k')) {
            return bitrateValue * 1000;
        }
        else if (bitrateString.toLowerCase().endsWith('m')) {
            return bitrateValue * 1_000_000;
        }
        else {
            return bitrateValue;
        }
    }
    async shouldUseExtractedImage(extractedPathOrBuffer, targetSize) {
        const { width, height } = await this.mediaRepository.getImageMetadata(extractedPathOrBuffer);
        const extractedSize = Math.min(width, height);
        return extractedSize >= targetSize;
    }
    async getDevices() {
        try {
            return await this.storageRepository.readdir('/dev/dri');
        }
        catch {
            this.logger.debug('No devices found in /dev/dri.');
            return [];
        }
    }
    async hasMaliOpenCL() {
        try {
            const [maliIcdStat, maliDeviceStat] = await Promise.all([
                this.storageRepository.stat('/etc/OpenCL/vendors/mali.icd'),
                this.storageRepository.stat('/dev/mali0'),
            ]);
            return maliIcdStat.isFile() && maliDeviceStat.isCharacterDevice();
        }
        catch {
            this.logger.debug('OpenCL not available for transcoding, so RKMPP acceleration will use CPU tonemapping');
            return false;
        }
    }
    async syncFiles(oldFiles, newFiles) {
        const toUpsert = [];
        const pathsToDelete = [];
        const toDelete = new Set(oldFiles);
        for (const newFile of newFiles) {
            const existingFile = oldFiles.find((file) => file.type === newFile.type && file.isEdited === newFile.isEdited);
            if (existingFile) {
                toDelete.delete(existingFile);
            }
            if (existingFile?.path !== newFile.path ||
                existingFile.isProgressive !== newFile.isProgressive ||
                existingFile.isTransparent !== newFile.isTransparent) {
                toUpsert.push(newFile);
                if (existingFile && existingFile.path !== newFile.path) {
                    this.logger.debug(`Deleting old ${newFile.type} image for asset ${newFile.assetId} in favor of a replacement`);
                    pathsToDelete.push(existingFile.path);
                }
            }
        }
        if (toUpsert.length > 0) {
            await this.assetRepository.upsertFiles(toUpsert);
        }
        if (toDelete.size > 0) {
            const toDeleteArray = [...toDelete];
            for (const file of toDeleteArray) {
                pathsToDelete.push(file.path);
            }
            await this.assetRepository.deleteFiles(toDeleteArray);
        }
        if (pathsToDelete.length > 0) {
            await this.jobRepository.queue({ name: enum_1.JobName.FileDelete, data: { files: pathsToDelete } });
        }
    }
    async generateEditedThumbnails(asset, config) {
        if (asset.type !== enum_1.AssetType.Image || (asset.files.length === 0 && asset.edits.length === 0)) {
            return;
        }
        const generated = asset.edits.length > 0 ? await this.generateImageThumbnails(asset, config, true) : undefined;
        const crop = asset.edits.find((e) => e.action === editing_dto_1.AssetEditAction.Crop);
        const cropBox = crop
            ? {
                x1: crop.parameters.x,
                y1: crop.parameters.y,
                x2: crop.parameters.x + crop.parameters.width,
                y2: crop.parameters.y + crop.parameters.height,
            }
            : undefined;
        const originalDimensions = (0, asset_util_1.getDimensions)(asset.exifInfo);
        const assetFaces = await this.personRepository.getFaces(asset.id, {});
        const ocrData = await this.ocrRepository.getByAssetId(asset.id, {});
        const faceStatuses = (0, editor_1.checkFaceVisibility)(assetFaces, originalDimensions, cropBox);
        await this.personRepository.updateVisibility(faceStatuses.visible, faceStatuses.hidden);
        const ocrStatuses = (0, editor_1.checkOcrVisibility)(ocrData, originalDimensions, cropBox);
        await this.ocrRepository.updateOcrVisibilities(asset.id, ocrStatuses.visible, ocrStatuses.hidden);
        return generated;
    }
    warnOnTransparencyLoss(isTransparent, format, assetId) {
        if (isTransparent && format === enum_1.ImageFormat.Jpeg) {
            this.logger.warn(`Asset ${assetId} has transparency but the configured format is ${format} which does not support it, consider using a format that does, such as ${enum_1.ImageFormat.Webp}`);
        }
    }
    getImageFile(asset, options) {
        const path = storage_core_1.StorageCore.getImagePath(asset, options);
        return {
            assetId: asset.id,
            type: options.fileType,
            path,
            isEdited: options.isEdited,
            isProgressive: options.isProgressive,
            isTransparent: options.isTransparent,
        };
    }
};
exports.MediaService = MediaService;
__decorate([
    (0, decorators_1.OnEvent)({ name: 'AppBootstrap' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "onBootstrap", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetGenerateThumbnailsQueueAll, queue: enum_1.QueueName.ThumbnailGeneration }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleQueueGenerateThumbnails", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.FileMigrationQueueAll, queue: enum_1.QueueName.Migration }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleQueueMigration", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetFileMigration, queue: enum_1.QueueName.Migration }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleAssetMigration", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetEditThumbnailGeneration, queue: enum_1.QueueName.Editor }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleAssetEditThumbnailGeneration", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetGenerateThumbnails, queue: enum_1.QueueName.ThumbnailGeneration }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleGenerateThumbnails", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.PersonGenerateThumbnail, queue: enum_1.QueueName.ThumbnailGeneration }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleGeneratePersonThumbnail", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetEncodeVideoQueueAll, queue: enum_1.QueueName.VideoConversion }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleQueueVideoConversion", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetEncodeVideo, queue: enum_1.QueueName.VideoConversion }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MediaService.prototype, "handleVideoConversion", null);
exports.MediaService = MediaService = __decorate([
    (0, common_1.Injectable)()
], MediaService);
//# sourceMappingURL=media.service.js.map
