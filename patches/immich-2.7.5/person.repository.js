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
exports.PersonRepository = void 0;
const common_1 = require("@nestjs/common");
const kysely_1 = require("kysely");
const postgres_1 = require("kysely/helpers/postgres");
const nestjs_kysely_1 = require("nestjs-kysely");
const decorators_1 = require("../decorators");
const enum_1 = require("../enum");
const database_1 = require("../utils/database");
const pagination_1 = require("../utils/pagination");
const withPerson = (eb) => {
    return (0, postgres_1.jsonObjectFrom)(eb.selectFrom('person').selectAll('person').whereRef('person.id', '=', 'asset_face.personId')).as('person');
};
const withFaceSearch = (eb) => {
    return (0, postgres_1.jsonObjectFrom)(eb.selectFrom('face_search').selectAll('face_search').whereRef('face_search.faceId', '=', 'asset_face.id')).as('faceSearch');
};
let PersonRepository = class PersonRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async reassignFaces({ oldPersonId, faceIds, newPersonId }) {
        const result = await this.db
            .updateTable('asset_face')
            .set({ personId: newPersonId })
            .$if(!!oldPersonId, (qb) => qb.where('asset_face.personId', '=', oldPersonId))
            .$if(!!faceIds, (qb) => qb.where('asset_face.id', 'in', faceIds))
            .executeTakeFirst();
        return Number(result.numChangedRows ?? 0);
    }
    async unassignFaces({ sourceType }) {
        await this.db
            .updateTable('asset_face')
            .set({ personId: null })
            .where('asset_face.sourceType', '=', sourceType)
            .execute();
    }
    async delete(ids) {
        if (ids.length === 0) {
            return;
        }
        await this.db.deleteFrom('person').where('person.id', 'in', ids).execute();
    }
    async deleteFaces({ sourceType }) {
        await this.db.deleteFrom('asset_face').where('asset_face.sourceType', '=', sourceType).execute();
    }
    getAllFaces(options = {}) {
        return this.db
            .selectFrom('asset_face')
            .selectAll('asset_face')
            .$if(options.personId === null, (qb) => qb.where('asset_face.personId', 'is', null))
            .$if(!!options.personId, (qb) => qb.where('asset_face.personId', '=', options.personId))
            .$if(!!options.sourceType, (qb) => qb.where('asset_face.sourceType', '=', options.sourceType))
            .$if(!!options.assetId, (qb) => qb.where('asset_face.assetId', '=', options.assetId))
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .stream();
    }
    getAll(options = {}) {
        return this.db
            .selectFrom('person')
            .selectAll('person')
            .$if(!!options.ownerId, (qb) => qb.where('person.ownerId', '=', options.ownerId))
            .$if(options.thumbnailPath !== undefined, (qb) => qb.where('person.thumbnailPath', '=', options.thumbnailPath))
            .$if(options.faceAssetId === null, (qb) => qb.where('person.faceAssetId', 'is', null))
            .$if(!!options.faceAssetId, (qb) => qb.where('person.faceAssetId', '=', options.faceAssetId))
            .$if(options.isHidden !== undefined, (qb) => qb.where('person.isHidden', '=', options.isHidden))
            .stream();
    }
    getFileSamples() {
        return this.db
            .selectFrom('person')
            .select(['id', 'thumbnailPath'])
            .where('thumbnailPath', '!=', kysely_1.sql.lit(''))
            .limit(kysely_1.sql.lit(3))
            .execute();
    }
    async getAllForUser(pagination, userId, options) {
        const items = await this.db
            .selectFrom('person')
            .selectAll('person')
            .innerJoin('asset_face', 'asset_face.personId', 'person.id')
            .innerJoin('asset', (join) => join
            .onRef('asset_face.assetId', '=', 'asset.id')
            .on('asset.visibility', '=', kysely_1.sql.lit(enum_1.AssetVisibility.Timeline))
            .on('asset.deletedAt', 'is', null))
            .where('person.ownerId', '=', userId)
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .orderBy('person.isHidden', 'asc')
            .orderBy('person.isFavorite', 'desc')
            .having((eb) => eb.or([
            eb('person.name', '!=', ''),
            eb((innerEb) => innerEb.fn.count('asset_face.assetId'), '>=', options?.minimumFaceCount || 1),
        ]))
            .groupBy('person.id')
            .$if(!!options?.closestFaceAssetId, (qb) => qb.orderBy((eb) => eb((eb) => eb
            .selectFrom('face_search')
            .select('face_search.embedding')
            .whereRef('face_search.faceId', '=', 'person.faceAssetId'), '<=>', (eb) => eb
            .selectFrom('face_search')
            .select('face_search.embedding')
            .where('face_search.faceId', '=', options.closestFaceAssetId))))
            .$if(!options?.closestFaceAssetId, (qb) => qb
            .orderBy((0, kysely_1.sql) `NULLIF(person.name, '') is null`, 'asc')
            .orderBy((eb) => eb.fn.count('asset_face.assetId'), 'desc')
            .orderBy((0, kysely_1.sql) `NULLIF(person.name, '')`, (om) => om.asc().nullsLast())
            .orderBy('person.createdAt'))
            .$if(!options?.withHidden, (qb) => qb.where('person.isHidden', '=', false))
            .offset(pagination.skip ?? 0)
            .limit(pagination.take + 1)
            .execute();
        return (0, pagination_1.paginationHelper)(items, pagination.take);
    }
    getAllWithoutFaces() {
        return this.db
            .selectFrom('person')
            .selectAll('person')
            .leftJoin('asset_face', 'asset_face.personId', 'person.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .having((eb) => eb.fn.count('asset_face.assetId'), '=', 0)
            .groupBy('person.id')
            .execute();
    }
    getFaces(assetId, options) {
        const isVisible = options === undefined ? true : options.isVisible;
        return this.db
            .selectFrom('asset_face')
            .selectAll('asset_face')
            .select(withPerson)
            .where('asset_face.assetId', '=', assetId)
            .where('asset_face.deletedAt', 'is', null)
            .$if(isVisible !== undefined, (qb) => qb.where('asset_face.isVisible', '=', isVisible))
            .orderBy('asset_face.boundingBoxX1', 'asc')
            .execute();
    }
    getFaceById(id) {
        return this.db
            .selectFrom('asset_face')
            .selectAll('asset_face')
            .select(withPerson)
            .where('asset_face.id', '=', id)
            .where('asset_face.deletedAt', 'is', null)
            .executeTakeFirstOrThrow();
    }
    getFaceForFacialRecognitionJob(id) {
        return this.db
            .selectFrom('asset_face')
            .select(['asset_face.id', 'asset_face.personId', 'asset_face.sourceType'])
            .select((eb) => (0, postgres_1.jsonObjectFrom)(eb
            .selectFrom('asset')
            .select(['asset.ownerId', 'asset.visibility', 'asset.fileCreatedAt'])
            .whereRef('asset.id', '=', 'asset_face.assetId')).as('asset'))
            .select(withFaceSearch)
            .where('asset_face.id', '=', id)
            .where('asset_face.deletedAt', 'is', null)
            .executeTakeFirst();
    }
    getDataForThumbnailGenerationJob(id) {
        return this.db
            .selectFrom('person')
            .innerJoin('asset_face', 'asset_face.id', 'person.faceAssetId')
            .innerJoin('asset', 'asset_face.assetId', 'asset.id')
            .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
            .select([
            'person.ownerId',
            'asset_face.boundingBoxX1 as x1',
            'asset_face.boundingBoxY1 as y1',
            'asset_face.boundingBoxX2 as x2',
            'asset_face.boundingBoxY2 as y2',
            'asset_face.imageWidth as oldWidth',
            'asset_face.imageHeight as oldHeight',
            'asset.type',
            'asset.originalPath',
            'asset_exif.orientation as exifOrientation',
        ])
            .select((eb) => (0, database_1.withFilePath)(eb, enum_1.AssetFileType.Thumbnail).as('previewPath'))
            .where('person.id', '=', id)
            .where('asset_face.deletedAt', 'is', null)
            .executeTakeFirst();
    }
    async reassignFace(assetFaceId, newPersonId) {
        const result = await this.db
            .updateTable('asset_face')
            .set({ personId: newPersonId })
            .where('asset_face.id', '=', assetFaceId)
            .executeTakeFirst();
        return Number(result.numChangedRows ?? 0);
    }
    getById(personId) {
        return this.db
            .selectFrom('person')
            .selectAll('person')
            .where('person.id', '=', personId)
            .executeTakeFirst();
    }
    getByName(userId, personName, { withHidden }) {
        return this.db
            .with('similarity_threshold', (db) => db.selectNoFrom((0, kysely_1.sql) `set_config('pg_trgm.word_similarity_threshold', '0.5', true)`.as('thresh')))
            .selectFrom(['similarity_threshold', 'person'])
            .selectAll('person')
            .where('person.ownerId', '=', userId)
            .where(() => (0, kysely_1.sql) `f_unaccent("person"."name") %> f_unaccent(${personName})`)
            .orderBy((0, kysely_1.sql) `f_unaccent("person"."name") <->>> f_unaccent(${personName})`)
            .limit(100)
            .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
            .execute();
    }
    getDistinctNames(userId, { withHidden }) {
        return this.db
            .selectFrom('person')
            .select(['person.id', 'person.name'])
            .distinctOn((eb) => eb.fn('lower', ['person.name']))
            .where((eb) => eb.and([eb('person.ownerId', '=', userId), eb('person.name', '!=', '')]))
            .$if(!withHidden, (qb) => qb.where('person.isHidden', '=', false))
            .execute();
    }
    async getStatistics(personId) {
        const result = await this.db
            .selectFrom('asset_face')
            .leftJoin('asset', (join) => join
            .onRef('asset.id', '=', 'asset_face.assetId')
            .on('asset.visibility', '=', kysely_1.sql.lit(enum_1.AssetVisibility.Timeline))
            .on('asset.deletedAt', 'is', null))
            .select((eb) => eb.fn.count(eb.fn('distinct', ['asset.id'])).as('count'))
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .where('asset_face.personId', '=', personId)
            .executeTakeFirst();
        return {
            assets: result ? Number(result.count) : 0,
        };
    }
    getNumberOfPeople(userId) {
        const zero = kysely_1.sql.lit(0);
        return this.db
            .selectFrom('person')
            .where((eb) => eb.exists((eb) => eb
            .selectFrom('asset_face')
            .whereRef('asset_face.personId', '=', 'person.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true)
            .where((eb) => eb.exists((eb) => eb
            .selectFrom('asset')
            .whereRef('asset.id', '=', 'asset_face.assetId')
            .where('asset.visibility', '=', kysely_1.sql.lit(enum_1.AssetVisibility.Timeline))
            .where('asset.deletedAt', 'is', null)))))
            .where('person.ownerId', '=', userId)
            .select((eb) => eb.fn.coalesce(eb.fn.countAll(), zero).as('total'))
            .select((eb) => eb.fn.coalesce(eb.fn.countAll().filterWhere('isHidden', '=', true), zero).as('hidden'))
            .executeTakeFirstOrThrow();
    }
    create(person) {
        return this.db.insertInto('person').values(person).returningAll().executeTakeFirstOrThrow();
    }
    async createAll(people) {
        if (people.length === 0) {
            return [];
        }
        const results = await this.db.insertInto('person').values(people).returningAll().execute();
        return results.map(({ id }) => id);
    }
    async refreshFaces(facesToAdd, faceIdsToRemove, embeddingsToAdd) {
        let query = this.db;
        if (facesToAdd.length > 0) {
            query = query.with('added', (db) => db.insertInto('asset_face').values(facesToAdd));
        }
        if (faceIdsToRemove.length > 0) {
            query = query.with('removed', (db) => db.deleteFrom('asset_face').where('asset_face.id', '=', (eb) => eb.fn.any(eb.val(faceIdsToRemove))));
        }
        if (embeddingsToAdd?.length) {
            query = query.with('added_embeddings', (db) => db.insertInto('face_search').values(embeddingsToAdd));
        }
        await query.selectFrom((0, kysely_1.sql) `(select 1)`.as('dummy')).execute();
    }
    async update(person) {
        return this.db
            .updateTable('person')
            .set(person)
            .where('person.id', '=', person.id)
            .returningAll()
            .executeTakeFirstOrThrow();
    }
    async updateAll(people) {
        if (people.length === 0) {
            return;
        }
        await this.db
            .insertInto('person')
            .values(people)
            .onConflict((oc) => oc.column('id').doUpdateSet((eb) => (0, database_1.removeUndefinedKeys)({
            name: eb.ref('excluded.name'),
            birthDate: eb.ref('excluded.birthDate'),
            thumbnailPath: eb.ref('excluded.thumbnailPath'),
            faceAssetId: eb.ref('excluded.faceAssetId'),
            isHidden: eb.ref('excluded.isHidden'),
            isFavorite: eb.ref('excluded.isFavorite'),
            color: eb.ref('excluded.color'),
        }, people[0])))
            .execute();
    }
    getFacesByIds(ids) {
        if (ids.length === 0) {
            return Promise.resolve([]);
        }
        const assetIds = [];
        const personIds = [];
        for (const { assetId, personId } of ids) {
            assetIds.push(assetId);
            personIds.push(personId);
        }
        return this.db
            .selectFrom('asset_face')
            .selectAll('asset_face')
            .select(withPerson)
            .where('asset_face.assetId', 'in', assetIds)
            .where('asset_face.personId', 'in', personIds)
            .where('asset_face.deletedAt', 'is', null)
            .execute();
    }
    getRandomFace(personId) {
        return this.db
            .selectFrom('asset_face')
            .innerJoin('asset', 'asset.id', 'asset_face.assetId')
            .selectAll('asset_face')
            .where('asset_face.personId', '=', personId)
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .where('asset.isOffline', '=', false)
            .where('asset.deletedAt', 'is', null)
            .where(({ exists, not, selectFrom }) => not(exists(selectFrom('invalid_media_path').select('originalPath').whereRef('originalPath', '=', 'asset.originalPath'))))
            .executeTakeFirst();
    }
    async getLatestFaceDate() {
        const result = (await this.db
            .selectFrom('asset_job_status')
            .select((eb) => (0, kysely_1.sql) `${eb.fn.max('asset_job_status.facesRecognizedAt')}::text`.as('latestDate'))
            .executeTakeFirst());
        return result?.latestDate;
    }
    async createAssetFace(face) {
        await this.db.insertInto('asset_face').values(face).execute();
    }
    async deleteAssetFace(id) {
        await this.db.deleteFrom('asset_face').where('asset_face.id', '=', id).execute();
    }
    async softDeleteAssetFaces(id) {
        await this.db.updateTable('asset_face').set({ deletedAt: new Date() }).where('asset_face.id', '=', id).execute();
    }
    async vacuum({ reindexVectors }) {
        await (0, kysely_1.sql) `VACUUM ANALYZE asset_face, face_search, person`.execute(this.db);
        await (0, kysely_1.sql) `REINDEX TABLE asset_face`.execute(this.db);
        await (0, kysely_1.sql) `REINDEX TABLE person`.execute(this.db);
        if (reindexVectors) {
            await (0, kysely_1.sql) `REINDEX TABLE face_search`.execute(this.db);
        }
    }
    getForPeopleDelete(ids) {
        if (ids.length === 0) {
            return Promise.resolve([]);
        }
        return this.db.selectFrom('person').select(['id', 'thumbnailPath']).where('id', 'in', ids).execute();
    }
    async updateVisibility(visible, hidden) {
        if (visible.length === 0 && hidden.length === 0) {
            return;
        }
        await this.db.transaction().execute(async (trx) => {
            if (visible.length > 0) {
                await trx
                    .updateTable('asset_face')
                    .set({ isVisible: true })
                    .where('asset_face.id', 'in', visible.map(({ id }) => id))
                    .execute();
            }
            if (hidden.length > 0) {
                await trx
                    .updateTable('asset_face')
                    .set({ isVisible: false })
                    .where('asset_face.id', 'in', hidden.map(({ id }) => id))
                    .execute();
            }
        });
    }
    getForFeatureFaceUpdate({ personId, assetId }) {
        return this.db
            .selectFrom('asset_face')
            .select('asset_face.id')
            .where('asset_face.assetId', '=', assetId)
            .where('asset_face.personId', '=', personId)
            .innerJoin('asset', (join) => join.onRef('asset.id', '=', 'asset_face.assetId').on('asset.isOffline', '=', false))
            .executeTakeFirst();
    }
};
exports.PersonRepository = PersonRepository;
__decorate([
    (0, decorators_1.GenerateSql)({ params: [{ oldPersonId: decorators_1.DummyValue.UUID, newPersonId: decorators_1.DummyValue.UUID }] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "reassignFaces", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [[decorators_1.DummyValue.UUID]] }),
    (0, decorators_1.Chunked)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "delete", null);
__decorate([
    (0, decorators_1.GenerateSql)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getFileSamples", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [{ take: 1, skip: 0 }, decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "getAllForUser", null);
__decorate([
    (0, decorators_1.GenerateSql)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getAllWithoutFaces", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getFaces", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getFaceById", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getFaceForFacialRecognitionJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getDataForThumbnailGenerationJob", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID, decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "reassignFace", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID, decorators_1.DummyValue.STRING, { withHidden: true }] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getByName", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID, { withHidden: true }] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "getDistinctNames", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "getStatistics", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getNumberOfPeople", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [[], [], [{ faceId: decorators_1.DummyValue.UUID, embedding: decorators_1.DummyValue.VECTOR }]] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array, Array, Array]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "refreshFaces", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [[{ assetId: decorators_1.DummyValue.UUID, personId: decorators_1.DummyValue.UUID }]] }),
    (0, decorators_1.ChunkedArray)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getFacesByIds", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getRandomFace", null);
__decorate([
    (0, decorators_1.GenerateSql)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "getLatestFaceDate", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "deleteAssetFace", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [decorators_1.DummyValue.UUID] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "softDeleteAssetFaces", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [[decorators_1.DummyValue.UUID]] }),
    (0, decorators_1.Chunked)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getForPeopleDelete", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [[], []] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array, Array]),
    __metadata("design:returntype", Promise)
], PersonRepository.prototype, "updateVisibility", null);
__decorate([
    (0, decorators_1.GenerateSql)({ params: [{ personId: decorators_1.DummyValue.UUID, assetId: decorators_1.DummyValue.UUID }] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PersonRepository.prototype, "getForFeatureFaceUpdate", null);
exports.PersonRepository = PersonRepository = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, nestjs_kysely_1.InjectKysely)()),
    __metadata("design:paramtypes", [kysely_1.Kysely])
], PersonRepository);
//# sourceMappingURL=person.repository.js.map
