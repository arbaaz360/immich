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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssetJobRepository = void 0;
const common_1 = require("@nestjs/common");
const kysely_1 = require("kysely");
const postgres_1 = require("kysely/helpers/postgres");
const nestjs_kysely_1 = require("nestjs-kysely");
const database_1 = require("../database");
const decorators_1 = require("../decorators");
const enum_1 = require("../enum");
const database_2 = require("../utils/database");
const mime_types_1 = require("../utils/mime-types");
let AssetJobRepository = class AssetJobRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    getForSearchDuplicatesJob(id) {
        return this.db
            .selectFrom('asset')
            .where('asset.id', '=', (0, database_2.asUuid)(id))
            .leftJoin('smart_search', 'asset.id', 'smart_search.assetId')
            .select(['id', 'type', 'ownerId', 'duplicateId', 'stackId', 'visibility', 'smart_search.embedding'])
            .limit(1)
            .executeTakeFirst();
    }
    getForSidecarWriteJob(id) {
        return this.db
            .selectFrom('asset')
            .where('asset.id', '=', (0, database_2.asUuid)(id))
            .select(['id', 'originalPath'])
            .select((eb) => (0, database_2.withFiles)(eb, enum_1.AssetFileType.Sidecar))
            .$call(database_2.withExifInner)
            .limit(1)
            .executeTakeFirst();
    }
    getForSidecarCheckJob(id) {
        return this.db
            .selectFrom('asset')
            .where('asset.id', '=', (0, database_2.asUuid)(id))
            .select(['id', 'originalPath'])
            .select((eb) => (0, database_2.withFiles)(eb, enum_1.AssetFileType.Sidecar))
            .limit(1)
            .executeTakeFirst();
    }
    streamForThumbnailJob(options) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id', 'asset.isEdited'])
            .where('asset.deletedAt', 'is', null)
            .where('asset.isOffline', '=', false)
            .where(({ exists, not, selectFrom }) => not(exists(selectFrom('invalid_media_path').select('originalPath').whereRef('originalPath', '=', 'asset.originalPath'))))
            .where('asset.visibility', '!=', kysely_1.sql.lit(enum_1.AssetVisibility.Hidden))
            .$if(!options.force, (qb) => qb
            .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
            .where(({ and, eb, exists, not, or, selectFrom }) => {
            const file = (type) => selectFrom('asset_file').whereRef('assetId', '=', 'asset.id').where('type', '=', kysely_1.sql.lit(type));
            const conditions = [
                not(exists(file(enum_1.AssetFileType.Thumbnail))),
                and([
                    eb('asset.isEdited', '=', kysely_1.sql.lit(true)),
                    not(exists(file(enum_1.AssetFileType.FullSize).where('asset_file.isEdited', '=', kysely_1.sql.lit(true)))),
                ]),
                eb('asset.thumbhash', 'is', null),
            ];
            if (options.fullsizeEnabled) {
                const isWebUnsupported = kysely_1.sql.join(Object.keys(mime_types_1.mimeTypes.webUnsupportedImage).map((ext) => kysely_1.sql.lit(`%${ext}`)));
                conditions.push(and([
                    not(exists(file(enum_1.AssetFileType.FullSize))),
                    eb((0, kysely_1.sql) `f_unaccent(asset."originalFileName")`, 'like', (0, kysely_1.sql) `any(array[${isWebUnsupported}]::text[])`),
                ]));
            }
            return or(conditions);
        }))
            .stream();
    }
    getForMigrationJob(id) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id', 'asset.ownerId'])
            .select(database_2.withFiles)
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    getForGenerateThumbnailJob(id) {
        return this.db
            .selectFrom('asset')
            .select([
            'asset.id',
            'asset.visibility',
            'asset.originalFileName',
            'asset.originalPath',
            'asset.ownerId',
            'asset.thumbhash',
            'asset.type',
        ])
            .select((eb) => (0, postgres_1.jsonArrayFrom)(eb
            .selectFrom('asset_file')
            .select(database_1.columns.assetFilesForThumbnail)
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', 'in', [enum_1.AssetFileType.Thumbnail, enum_1.AssetFileType.Preview, enum_1.AssetFileType.FullSize])).as('files'))
            .select(database_2.withEdits)
            .$call(database_2.withExifInner)
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    getForMetadataExtraction(id) {
        return this.db
            .selectFrom('asset')
            .select(database_1.columns.asset)
            .select(database_2.withFaces)
            .select((eb) => (0, database_2.withFiles)(eb, enum_1.AssetFileType.Sidecar))
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    async getLockedPropertiesForMetadataExtraction(assetId) {
        return this.db
            .selectFrom('asset_exif')
            .select('asset_exif.lockedProperties')
            .where('asset_exif.assetId', '=', assetId)
            .executeTakeFirst()
            .then((row) => row?.lockedProperties ?? []);
    }
    getAlbumThumbnailFiles(id, fileType) {
        return this.db
            .selectFrom('asset_file')
            .select(database_1.columns.assetFiles)
            .where('asset_file.assetId', '=', id)
            .$if(!!fileType, (qb) => qb.where('asset_file.type', '=', fileType))
            .execute();
    }
    assetsWithPreviews() {
        return this.db
            .selectFrom('asset')
            .where('asset.type', '=', kysely_1.sql.lit(enum_1.AssetType.Image))
            .where('asset.isOffline', '=', false)
            .where(({ exists, not, selectFrom }) => not(exists(selectFrom('invalid_media_path').select('originalPath').whereRef('originalPath', '=', 'asset.originalPath'))))
            .where('asset.visibility', '!=', enum_1.AssetVisibility.Hidden)
            .where('asset.deletedAt', 'is', null)
            .innerJoin('asset_job_status as job_status', 'assetId', 'asset.id');
    }
    streamForSearchDuplicates(force) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id'])
            .where('asset.deletedAt', 'is', null)
            .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
            .$call(database_2.withDefaultVisibility)
            .$if(!force, (qb) => qb
            .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
            .where('job_status.duplicatesDetectedAt', 'is', null))
            .stream();
    }
    streamForEncodeClip(force) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id'])
            .where('asset.type', '=', kysely_1.sql.lit(enum_1.AssetType.Image))
            .where('asset.deletedAt', 'is', null)
            .$call(database_2.withDefaultVisibility)
            .$if(!force, (qb) => qb.where((eb) => eb.not((eb) => eb.exists(eb.selectFrom('smart_search').whereRef('assetId', '=', 'asset.id')))))
            .stream();
    }
    getForClipEncoding(id) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id', 'asset.visibility', 'asset.originalPath'])
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    getForDetectFacesJob(id) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id', 'asset.visibility', 'asset.originalPath'])
            .$call(database_2.withExifInner)
            .select((eb) => (0, database_2.withFaces)(eb, true, true))
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    getForOcr(id) {
        return this.db
            .selectFrom('asset')
            .select(['asset.visibility', 'asset.originalPath'])
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    getForSyncAssets(ids) {
        return this.db
            .selectFrom('asset')
            .select([
            'asset.id',
            'asset.isOffline',
            'asset.libraryId',
            'asset.originalPath',
            'asset.status',
            'asset.fileModifiedAt',
        ])
            .where('asset.id', '=', (0, database_2.anyUuid)(ids))
            .execute();
    }
    getForAssetDeletion(id) {
        return this.db
            .selectFrom('asset')
            .select([
            'asset.id',
            'asset.visibility',
            'asset.libraryId',
            'asset.ownerId',
            'asset.livePhotoVideoId',
            'asset.originalPath',
            'asset.isOffline',
        ])
            .$call(database_2.withExif)
            .select(database_2.withFiles)
            .leftJoinLateral((eb) => eb
            .selectFrom('stack')
            .whereRef('stack.id', '=', 'asset.stackId')
            .select((eb) => [
            'stack.id',
            'stack.primaryAssetId',
            (0, postgres_1.jsonArrayFrom)(eb
                .selectFrom('asset as stack_asset')
                .select(['stack_asset.id'])
                .whereRef('stack_asset.stackId', '=', 'stack.id')
                .whereRef('stack_asset.id', '!=', 'stack.primaryAssetId')
                .where('stack_asset.visibility', '=', kysely_1.sql.val(enum_1.AssetVisibility.Timeline))
                .where('stack_asset.status', '!=', kysely_1.sql.val(enum_1.AssetStatus.Deleted))).as('assets'),
        ])
            .as('stack_result'), (join) => join.onTrue())
            .select((eb) => eb.fn
            .toJson(eb.table('stack_result'))
            .$castTo()
            .as('stack'))
            .where('asset.id', '=', id)
            .executeTakeFirst();
    }
    streamForVideoConversion(force) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id'])
            .where('asset.type', '=', kysely_1.sql.lit(enum_1.AssetType.Video))
            .$if(!force, (qb) => qb
            .where((eb) => eb.not(eb.exists(eb
            .selectFrom('asset_file')
            .select('asset_file.id')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', kysely_1.sql.lit(enum_1.AssetFileType.EncodedVideo)))))
            .where('asset.visibility', '!=', kysely_1.sql.lit(enum_1.AssetVisibility.Hidden)))
            .where('asset.deletedAt', 'is', null)
            .stream();
    }
    getForVideoConversion(id) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id', 'asset.ownerId', 'asset.originalPath'])
            .select(database_2.withFiles)
            .where('asset.id', '=', id)
            .where('asset.type', '=', kysely_1.sql.lit(enum_1.AssetType.Video))
            .executeTakeFirst();
    }
    streamForMetadataExtraction(force) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id'])
            .$if(!force, (qb) => qb
            .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
            .where((eb) => eb.or([eb('asset_job_status.metadataExtractedAt', 'is', null), eb('asset_job_status.assetId', 'is', null)])))
            .where('asset.deletedAt', 'is', null)
            .stream();
    }
    storageTemplateAssetQuery() {
        return this.db
            .selectFrom('asset')
            .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
            .select([
            'asset.id',
            'asset.ownerId',
            'asset.type',
            'asset.checksum',
            'asset.originalPath',
            'asset.isExternal',
            'asset.visibility',
            'asset.originalFileName',
            'asset.livePhotoVideoId',
            'asset.fileCreatedAt',
            'asset_exif.timeZone',
            'asset_exif.fileSizeInByte',
            'asset_exif.make',
            'asset_exif.model',
            'asset_exif.lensModel',
        ])
            .select((eb) => (0, database_2.withFiles)(eb, enum_1.AssetFileType.Sidecar))
            .where('asset.deletedAt', 'is', null);
    }
    getForStorageTemplateJob(id, options) {
        return this.storageTemplateAssetQuery()
            .where('asset.id', '=', id)
            .$if(!options?.includeHidden, (qb) => qb.where('asset.visibility', '!=', enum_1.AssetVisibility.Hidden))
            .executeTakeFirst();
    }
    streamForStorageTemplateJob() {
        return this.storageTemplateAssetQuery().where('asset.visibility', '!=', enum_1.AssetVisibility.Hidden).stream();
    }
    streamForDeletedJob(trashedBefore) {
        return this.db
            .selectFrom('asset')
            .select(['id', 'isOffline'])
            .where('asset.deletedAt', '<=', trashedBefore)
            .stream();
    }
    streamForSidecar(force) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id'])
            .$if(!force, (qb) => qb.where((eb) => eb.not(eb.exists(eb
            .selectFrom('asset_file')
            .select('asset_file.id')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', enum_1.AssetFileType.Sidecar)))))
            .stream();
    }
    streamForDetectFacesJob(force) {
        return this.assetsWithPreviews()
            .$if(force === false, (qb) => qb.where('job_status.facesRecognizedAt', 'is', null))
            .select(['asset.id'])
            .orderBy('asset.fileCreatedAt', 'desc')
            .stream();
    }
    streamForOcrJob(force) {
        return this.db
            .selectFrom('asset')
            .select(['asset.id'])
            .$if(!force, (qb) => qb
            .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
            .where('asset_job_status.ocrAt', 'is', null))
            .where('asset.type', '=', kysely_1.sql.lit(enum_1.AssetType.Image))
            .where('asset.deletedAt', 'is', null)
            .where('asset.visibility', '!=', enum_1.AssetVisibility.Hidden)
            .stream();
    }
    streamForMigrationJob() {
        return this.db.selectFrom('asset').select(['id']).where('asset.deletedAt', 'is', null).stream();
    }
};
exports.AssetJobRepository = AssetJobRepository;
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForSearchDuplicatesJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForSidecarWriteJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForSidecarCheckJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [{ force: false, fullsizeEnabled: true }], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForThumbnailJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForMigrationJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForGenerateThumbnailJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForMetadataExtraction", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AssetJobRepository.prototype, "getLockedPropertiesForMetadataExtraction", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID, enum_1.AssetFileType.Thumbnail] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getAlbumThumbnailFiles", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForSearchDuplicates", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForEncodeClip", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForClipEncoding", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForDetectFacesJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForOcr", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [[decorators_1.DummyValue.UUID]] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForSyncAssets", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForAssetDeletion", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForVideoConversion", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForVideoConversion", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForMetadataExtraction", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "getForStorageTemplateJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForStorageTemplateJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.DATE], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Date]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForDeletedJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForSidecar", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForDetectFacesJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Boolean]),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForOcrJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.DATE], stream: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AssetJobRepository.prototype, "streamForMigrationJob", null);
exports.AssetJobRepository = AssetJobRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, nestjs_kysely_1.InjectKysely)()),
    __metadata("design:paramtypes", [kysely_1.Kysely])
], AssetJobRepository);
//# sourceMappingURL=asset-job.repository.js.map
