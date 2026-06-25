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
exports.PersonService = void 0;
const common_1 = require("@nestjs/common");
const constants_1 = require("../constants");
const decorators_1 = require("../decorators");
const asset_ids_response_dto_1 = require("../dtos/asset-ids.response.dto");
const person_dto_1 = require("../dtos/person.dto");
const enum_1 = require("../enum");
const base_service_1 = require("./base.service");
const asset_util_1 = require("../utils/asset.util");
const file_1 = require("../utils/file");
const mime_types_1 = require("../utils/mime-types");
const misc_1 = require("../utils/misc");
const transform_1 = require("../utils/transform");
let PersonService = class PersonService extends base_service_1.BaseService {
    async getAll(auth, dto) {
        const { withHidden = false, closestAssetId, closestPersonId, page, size } = dto;
        let closestFaceAssetId = closestAssetId;
        const pagination = {
            take: size,
            skip: (page - 1) * size,
        };
        if (closestPersonId) {
            const person = await this.personRepository.getById(closestPersonId);
            if (!person?.faceAssetId) {
                throw new common_1.NotFoundException('Person not found');
            }
            closestFaceAssetId = person.faceAssetId;
        }
        const { machineLearning } = await this.getConfig({ withCache: false });
        const { items, hasNextPage } = await this.personRepository.getAllForUser(pagination, auth.user.id, {
            minimumFaceCount: machineLearning.facialRecognition.minFaces,
            withHidden,
            closestFaceAssetId,
        });
        const { total, hidden } = await this.personRepository.getNumberOfPeople(auth.user.id);
        return {
            people: items.map((person) => (0, person_dto_1.mapPerson)(person)),
            hasNextPage,
            total,
            hidden,
        };
    }
    async reassignFaces(auth, personId, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonUpdate, ids: [personId] });
        const person = await this.findOrFail(personId);
        const result = [];
        const changeFeaturePhoto = [];
        for (const data of dto.data) {
            const faces = await this.personRepository.getFacesByIds([{ personId: data.personId, assetId: data.assetId }]);
            for (const face of faces) {
                await this.requireAccess({ auth, permission: enum_1.Permission.PersonCreate, ids: [face.id] });
                if (person.faceAssetId === null) {
                    changeFeaturePhoto.push(person.id);
                }
                if (face.person && face.person.faceAssetId === face.id) {
                    changeFeaturePhoto.push(face.person.id);
                }
                await this.personRepository.reassignFace(face.id, personId);
            }
            result.push((0, person_dto_1.mapPerson)(person));
        }
        if (changeFeaturePhoto.length > 0) {
            await this.createNewFeaturePhoto([...new Set(changeFeaturePhoto)]);
        }
        return result;
    }
    async reassignFacesById(auth, personId, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonUpdate, ids: [personId] });
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonCreate, ids: [dto.id] });
        const face = await this.personRepository.getFaceById(dto.id);
        const person = await this.findOrFail(personId);
        await this.personRepository.reassignFace(face.id, personId);
        if (person.faceAssetId === null) {
            await this.createNewFeaturePhoto([person.id]);
        }
        if (face.person && face.person.faceAssetId === face.id) {
            await this.createNewFeaturePhoto([face.person.id]);
        }
        return await this.findOrFail(personId).then(person_dto_1.mapPerson);
    }
    async getFacesById(auth, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.AssetRead, ids: [dto.id] });
        const faces = await this.personRepository.getFaces(dto.id);
        const asset = await this.assetRepository.getForFaces(dto.id);
        const assetDimensions = (0, asset_util_1.getDimensions)(asset);
        return faces.map((face) => (0, person_dto_1.mapFaces)(face, auth, asset.edits, assetDimensions));
    }
    async createNewFeaturePhoto(changeFeaturePhoto) {
        this.logger.debug(`Changing feature photos for ${changeFeaturePhoto.length} ${changeFeaturePhoto.length > 1 ? 'people' : 'person'}`);
        const jobs = [];
        for (const personId of changeFeaturePhoto) {
            const assetFace = await this.personRepository.getRandomFace(personId);
            if (assetFace) {
                await this.personRepository.update({ id: personId, faceAssetId: assetFace.id });
                jobs.push({ name: enum_1.JobName.PersonGenerateThumbnail, data: { id: personId } });
            }
        }
        await this.jobRepository.queueAll(jobs);
    }
    async getById(auth, id) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonRead, ids: [id] });
        return this.findOrFail(id).then(person_dto_1.mapPerson);
    }
    async getStatistics(auth, id) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonRead, ids: [id] });
        return this.personRepository.getStatistics(id);
    }
    async getThumbnail(auth, id) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonRead, ids: [id] });
        const person = await this.personRepository.getById(id);
        if (!person || !person.thumbnailPath) {
            throw new common_1.NotFoundException();
        }
        return new file_1.ImmichFileResponse({
            path: person.thumbnailPath,
            contentType: mime_types_1.mimeTypes.lookup(person.thumbnailPath),
            cacheControl: enum_1.CacheControl.PrivateWithoutCache,
        });
    }
    async create(auth, dto) {
        const person = await this.personRepository.create({
            ownerId: auth.user.id,
            name: dto.name,
            birthDate: dto.birthDate,
            isHidden: dto.isHidden,
            isFavorite: dto.isFavorite,
            color: dto.color,
        });
        return (0, person_dto_1.mapPerson)(person);
    }
    async update(auth, id, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonUpdate, ids: [id] });
        const { name, birthDate, isHidden, featureFaceAssetId: assetId, isFavorite, color } = dto;
        let faceId = undefined;
        if (assetId) {
            await this.requireAccess({ auth, permission: enum_1.Permission.AssetRead, ids: [assetId] });
            const face = await this.personRepository.getForFeatureFaceUpdate({ personId: id, assetId });
            if (!face) {
                throw new common_1.BadRequestException('Invalid assetId for feature face or asset is offline');
            }
            faceId = face.id;
        }
        const person = await this.personRepository.update({
            id,
            faceAssetId: faceId,
            name,
            birthDate,
            isHidden,
            isFavorite,
            color,
        });
        if (assetId) {
            await this.jobRepository.queue({ name: enum_1.JobName.PersonGenerateThumbnail, data: { id } });
        }
        return (0, person_dto_1.mapPerson)(person);
    }
    delete(auth, id) {
        return this.deleteAll(auth, { ids: [id] });
    }
    async updateAll(auth, dto) {
        const results = [];
        for (const person of dto.people) {
            try {
                await this.update(auth, person.id, {
                    isHidden: person.isHidden,
                    name: person.name,
                    birthDate: person.birthDate,
                    featureFaceAssetId: person.featureFaceAssetId,
                    isFavorite: person.isFavorite,
                });
                results.push({ id: person.id, success: true });
            }
            catch (error) {
                this.logger.error(`Unable to update ${person.id} : ${error}`, error?.stack);
                results.push({ id: person.id, success: false, error: asset_ids_response_dto_1.BulkIdErrorReason.UNKNOWN });
            }
        }
        return results;
    }
    async deleteAll(auth, { ids }) {
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonDelete, ids });
        const people = await this.personRepository.getForPeopleDelete(ids);
        await this.removeAllPeople(people);
    }
    async removeAllPeople(people) {
        await Promise.all(people.map((person) => this.storageRepository.unlink(person.thumbnailPath)));
        await this.personRepository.delete(people.map((person) => person.id));
        this.logger.debug(`Deleted ${people.length} people`);
    }
    async handlePersonCleanup() {
        const people = await this.personRepository.getAllWithoutFaces();
        await this.removeAllPeople(people);
        return enum_1.JobStatus.Success;
    }
    async handleQueueDetectFaces({ force }) {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!(0, misc_1.isFacialRecognitionEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        if (force) {
            await this.personRepository.deleteFaces({ sourceType: enum_1.SourceType.MachineLearning });
            await this.handlePersonCleanup();
            await this.personRepository.vacuum({ reindexVectors: true });
        }
        let jobs = [];
        const assets = this.assetJobRepository.streamForDetectFacesJob(force);
        for await (const asset of assets) {
            jobs.push({ name: enum_1.JobName.AssetDetectFaces, data: { id: asset.id } });
            if (jobs.length >= constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await this.jobRepository.queueAll(jobs);
                jobs = [];
            }
        }
        await this.jobRepository.queueAll(jobs);
        if (force === undefined) {
            await this.jobRepository.queue({ name: enum_1.JobName.PersonCleanup });
        }
        return enum_1.JobStatus.Success;
    }
    async handleDetectFaces({ id }) {
        const { machineLearning } = await this.getConfig({ withCache: true });
        if (!(0, misc_1.isFacialRecognitionEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        const asset = await this.assetJobRepository.getForDetectFacesJob(id);
        if (!asset?.originalPath) {
            return enum_1.JobStatus.Failed;
        }
        if (asset.visibility === enum_1.AssetVisibility.Hidden) {
            return enum_1.JobStatus.Skipped;
        }
        const { imageHeight, imageWidth, faces } = await this.machineLearningRepository.detectFaces(asset.originalPath, machineLearning.facialRecognition);
        this.logger.debug(`${faces.length} faces detected in ${asset.originalPath}`);
        const facesToAdd = [];
        const embeddings = [];
        const mlFaceIds = new Set();
        for (const face of asset.faces) {
            if (face.sourceType === enum_1.SourceType.MachineLearning) {
                mlFaceIds.add(face.id);
            }
        }
        const heightScale = imageHeight / (asset.faces[0]?.imageHeight || 1);
        const widthScale = imageWidth / (asset.faces[0]?.imageWidth || 1);
        for (const { boundingBox, embedding } of faces) {
            const scaledBox = {
                x1: boundingBox.x1 * widthScale,
                y1: boundingBox.y1 * heightScale,
                x2: boundingBox.x2 * widthScale,
                y2: boundingBox.y2 * heightScale,
            };
            const match = asset.faces.find((face) => this.iou(face, scaledBox) > 0.5);
            if (match && !mlFaceIds.delete(match.id)) {
                embeddings.push({ faceId: match.id, embedding });
            }
            else if (!match) {
                const faceId = this.cryptoRepository.randomUUID();
                facesToAdd.push({
                    id: faceId,
                    assetId: asset.id,
                    imageHeight,
                    imageWidth,
                    boundingBoxX1: boundingBox.x1,
                    boundingBoxY1: boundingBox.y1,
                    boundingBoxX2: boundingBox.x2,
                    boundingBoxY2: boundingBox.y2,
                });
                embeddings.push({ faceId, embedding });
            }
        }
        const faceIdsToRemove = [...mlFaceIds];
        if (facesToAdd.length > 0 || faceIdsToRemove.length > 0 || embeddings.length > 0) {
            await this.personRepository.refreshFaces(facesToAdd, faceIdsToRemove, embeddings);
        }
        if (faceIdsToRemove.length > 0) {
            this.logger.log(`Removed ${faceIdsToRemove.length} faces below detection threshold in asset ${id}`);
        }
        if (facesToAdd.length > 0) {
            this.logger.log(`Detected ${facesToAdd.length} new faces in asset ${id}`);
            const jobs = facesToAdd.map((face) => ({ name: enum_1.JobName.FacialRecognition, data: { id: face.id } }));
            await this.jobRepository.queueAll([{ name: enum_1.JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);
        }
        else if (embeddings.length > 0) {
            this.logger.log(`Added ${embeddings.length} face embeddings for asset ${id}`);
        }
        await this.assetRepository.upsertJobStatus({ assetId: asset.id, facesRecognizedAt: new Date() });
        return enum_1.JobStatus.Success;
    }
    iou(face, newBox) {
        const x1 = Math.max(face.boundingBoxX1, newBox.x1);
        const y1 = Math.max(face.boundingBoxY1, newBox.y1);
        const x2 = Math.min(face.boundingBoxX2, newBox.x2);
        const y2 = Math.min(face.boundingBoxY2, newBox.y2);
        const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const area1 = (face.boundingBoxX2 - face.boundingBoxX1) * (face.boundingBoxY2 - face.boundingBoxY1);
        const area2 = (newBox.x2 - newBox.x1) * (newBox.y2 - newBox.y1);
        const union = area1 + area2 - intersection;
        return intersection / union;
    }
    async handleQueueRecognizeFaces({ force, nightly }) {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!(0, misc_1.isFacialRecognitionEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        await this.jobRepository.waitForQueueCompletion(enum_1.QueueName.ThumbnailGeneration, enum_1.QueueName.FaceDetection);
        if (nightly) {
            const [state, latestFaceDate] = await Promise.all([
                this.systemMetadataRepository.get(enum_1.SystemMetadataKey.FacialRecognitionState),
                this.personRepository.getLatestFaceDate(),
            ]);
            if (state?.lastRun && latestFaceDate && state.lastRun > latestFaceDate) {
                this.logger.debug('Skipping facial recognition nightly since no face has been added since the last run');
                return enum_1.JobStatus.Skipped;
            }
        }
        const { waiting } = await this.jobRepository.getJobCounts(enum_1.QueueName.FacialRecognition);
        if (force) {
            await this.personRepository.unassignFaces({ sourceType: enum_1.SourceType.MachineLearning });
            await this.handlePersonCleanup();
            await this.personRepository.vacuum({ reindexVectors: false });
        }
        else if (waiting) {
            this.logger.debug(`Skipping facial recognition queueing because ${waiting} job${waiting > 1 ? 's are' : ' is'} already queued`);
            return enum_1.JobStatus.Skipped;
        }
        await this.databaseRepository.prewarm(enum_1.VectorIndex.Face);
        const lastRun = new Date().toISOString();
        const facePagination = this.personRepository.getAllFaces(force ? undefined : { personId: null, sourceType: enum_1.SourceType.MachineLearning });
        let jobs = [];
        for await (const face of facePagination) {
            jobs.push({ name: enum_1.JobName.FacialRecognition, data: { id: face.id, deferred: false } });
            if (jobs.length === constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await this.jobRepository.queueAll(jobs);
                jobs = [];
            }
        }
        await this.jobRepository.queueAll(jobs);
        await this.systemMetadataRepository.set(enum_1.SystemMetadataKey.FacialRecognitionState, { lastRun });
        return enum_1.JobStatus.Success;
    }
    async handleRecognizeFaces({ id, deferred }) {
        const { machineLearning } = await this.getConfig({ withCache: true });
        if (!(0, misc_1.isFacialRecognitionEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        const face = await this.personRepository.getFaceForFacialRecognitionJob(id);
        if (!face || !face.asset) {
            this.logger.warn(`Face ${id} not found`);
            return enum_1.JobStatus.Failed;
        }
        if (face.sourceType !== enum_1.SourceType.MachineLearning) {
            this.logger.warn(`Skipping face ${id} due to source ${face.sourceType}`);
            return enum_1.JobStatus.Skipped;
        }
        if (!face.faceSearch?.embedding) {
            this.logger.warn(`Face ${id} does not have an embedding`);
            return enum_1.JobStatus.Failed;
        }
        if (face.personId) {
            this.logger.debug(`Face ${id} already has a person assigned`);
            return enum_1.JobStatus.Skipped;
        }
        const matches = await this.searchRepository.searchFaces({
            userIds: [face.asset.ownerId],
            embedding: face.faceSearch.embedding,
            maxDistance: machineLearning.facialRecognition.maxDistance,
            numResults: machineLearning.facialRecognition.minFaces,
            minBirthDate: new Date(face.asset.fileCreatedAt),
        });
        if (machineLearning.facialRecognition.minFaces > 1 && matches.length <= 1) {
            this.logger.debug(`Face ${id} only matched the face itself, skipping`);
            return enum_1.JobStatus.Skipped;
        }
        this.logger.debug(`Face ${id} has ${matches.length} matches`);
        const isCore = matches.length >= machineLearning.facialRecognition.minFaces &&
            face.asset.visibility === enum_1.AssetVisibility.Timeline;
        if (!isCore && !deferred) {
            this.logger.debug(`Deferring non-core face ${id} for later processing`);
            await this.jobRepository.queue({ name: enum_1.JobName.FacialRecognition, data: { id, deferred: true } });
            return enum_1.JobStatus.Skipped;
        }
        let personId = matches.find((match) => match.personId)?.personId;
        if (!personId) {
            const matchWithPerson = await this.searchRepository.searchFaces({
                userIds: [face.asset.ownerId],
                embedding: face.faceSearch.embedding,
                maxDistance: machineLearning.facialRecognition.maxDistance,
                numResults: 1,
                hasPerson: true,
                minBirthDate: new Date(face.asset.fileCreatedAt),
            });
            if (matchWithPerson.length > 0) {
                personId = matchWithPerson[0].personId;
            }
        }
        if (isCore && !personId) {
            this.logger.log(`Creating new person for face ${id}`);
            const newPerson = await this.personRepository.create({ ownerId: face.asset.ownerId, faceAssetId: face.id });
            await this.jobRepository.queue({ name: enum_1.JobName.PersonGenerateThumbnail, data: { id: newPerson.id } });
            personId = newPerson.id;
        }
        if (personId) {
            this.logger.debug(`Assigning face ${id} to person ${personId}`);
            await this.personRepository.reassignFaces({ faceIds: [id], newPersonId: personId });
        }
        return enum_1.JobStatus.Success;
    }
    async handlePersonMigration({ id }) {
        const person = await this.personRepository.getById(id);
        if (!person) {
            return enum_1.JobStatus.Failed;
        }
        await this.storageCore.movePersonFile(person, enum_1.PersonPathType.Face);
        return enum_1.JobStatus.Success;
    }
    async mergePerson(auth, id, dto) {
        const mergeIds = dto.ids;
        if (mergeIds.includes(id)) {
            throw new common_1.BadRequestException('Cannot merge a person into themselves');
        }
        await this.requireAccess({ auth, permission: enum_1.Permission.PersonUpdate, ids: [id] });
        let primaryPerson = await this.findOrFail(id);
        const primaryName = primaryPerson.name || primaryPerson.id;
        const results = [];
        const allowedIds = await this.checkAccess({
            auth,
            permission: enum_1.Permission.PersonMerge,
            ids: mergeIds,
        });
        for (const mergeId of mergeIds) {
            const hasAccess = allowedIds.has(mergeId);
            if (!hasAccess) {
                results.push({ id: mergeId, success: false, error: asset_ids_response_dto_1.BulkIdErrorReason.NO_PERMISSION });
                continue;
            }
            try {
                const mergePerson = await this.personRepository.getById(mergeId);
                if (!mergePerson) {
                    results.push({ id: mergeId, success: false, error: asset_ids_response_dto_1.BulkIdErrorReason.NOT_FOUND });
                    continue;
                }
                const update = { id: primaryPerson.id };
                if (!primaryPerson.name && mergePerson.name) {
                    update.name = mergePerson.name;
                }
                if (!primaryPerson.birthDate && mergePerson.birthDate) {
                    update.birthDate = mergePerson.birthDate;
                }
                if (Object.keys(update).length > 1) {
                    primaryPerson = await this.personRepository.update(update);
                }
                const mergeName = mergePerson.name || mergePerson.id;
                const mergeData = { oldPersonId: mergeId, newPersonId: id };
                this.logger.log(`Merging ${mergeName} into ${primaryName}`);
                await this.personRepository.reassignFaces(mergeData);
                await this.removeAllPeople([mergePerson]);
                this.logger.log(`Merged ${mergeName} into ${primaryName}`);
                results.push({ id: mergeId, success: true });
            }
            catch (error) {
                this.logger.error(`Unable to merge ${mergeId} into ${id}: ${error}`, error?.stack);
                results.push({ id: mergeId, success: false, error: asset_ids_response_dto_1.BulkIdErrorReason.UNKNOWN });
            }
        }
        return results;
    }
    async findOrFail(id) {
        const person = await this.personRepository.getById(id);
        if (!person) {
            throw new common_1.BadRequestException('Person not found');
        }
        return person;
    }
    async createFace(auth, dto) {
        await Promise.all([
            this.requireAccess({ auth, permission: enum_1.Permission.AssetRead, ids: [dto.assetId] }),
            this.requireAccess({ auth, permission: enum_1.Permission.PersonRead, ids: [dto.personId] }),
        ]);
        const [asset, person] = await Promise.all([
            this.assetRepository.getById(dto.assetId, { edits: true, exifInfo: true }),
            this.findOrFail(dto.personId),
        ]);
        if (!asset) {
            throw new common_1.NotFoundException('Asset not found');
        }
        const edits = asset.edits || [];
        let topLeft = { x: dto.x, y: dto.y };
        let bottomRight = { x: dto.x + dto.width, y: dto.y + dto.height };
        if (edits.length > 0) {
            if (!asset.width || !asset.height || !asset.exifInfo?.exifImageWidth || !asset.exifInfo?.exifImageHeight) {
                throw new common_1.BadRequestException('Asset does not have valid dimensions');
            }
            const scaleFactor = asset.width / dto.imageWidth;
            topLeft = { x: topLeft.x * scaleFactor, y: topLeft.y * scaleFactor };
            bottomRight = { x: bottomRight.x * scaleFactor, y: bottomRight.y * scaleFactor };
            const { points: [invertedTopLeft, invertedBottomRight], } = (0, transform_1.transformPoints)([topLeft, bottomRight], edits, { width: asset.width, height: asset.height }, { inverse: true });
            topLeft = {
                x: Math.min(invertedTopLeft.x, invertedBottomRight.x),
                y: Math.min(invertedTopLeft.y, invertedBottomRight.y),
            };
            bottomRight = {
                x: Math.max(invertedTopLeft.x, invertedBottomRight.x),
                y: Math.max(invertedTopLeft.y, invertedBottomRight.y),
            };
            const originalDimensions = (0, asset_util_1.getDimensions)(asset.exifInfo);
            dto.imageWidth = originalDimensions.width;
            dto.imageHeight = originalDimensions.height;
        }
        await this.personRepository.createAssetFace({
            personId: dto.personId,
            assetId: dto.assetId,
            imageHeight: dto.imageHeight,
            imageWidth: dto.imageWidth,
            boundingBoxX1: Math.round(topLeft.x),
            boundingBoxX2: Math.round(bottomRight.x),
            boundingBoxY1: Math.round(topLeft.y),
            boundingBoxY2: Math.round(bottomRight.y),
            sourceType: enum_1.SourceType.Manual,
        });
        if (!person.faceAssetId) {
            await this.createNewFeaturePhoto([person.id]);
        }
    }
    async deleteFace(auth, id, dto) {
        await this.requireAccess({ auth, permission: enum_1.Permission.FaceDelete, ids: [id] });
        return dto.force ? this.personRepository.deleteAssetFace(id) : this.personRepository.softDeleteAssetFaces(id);
    }
};
exports.PersonService = PersonService;
__decorate([
    (0, decorators_1.Chunked)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array]),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "removeAllPeople", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.PersonCleanup, queue: enum_1.QueueName.BackgroundTask }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "handlePersonCleanup", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetDetectFacesQueueAll, queue: enum_1.QueueName.FaceDetection }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "handleQueueDetectFaces", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.AssetDetectFaces, queue: enum_1.QueueName.FaceDetection }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "handleDetectFaces", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.FacialRecognitionQueueAll, queue: enum_1.QueueName.FacialRecognition }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "handleQueueRecognizeFaces", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.FacialRecognition, queue: enum_1.QueueName.FacialRecognition }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "handleRecognizeFaces", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.PersonFileMigration, queue: enum_1.QueueName.Migration }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PersonService.prototype, "handlePersonMigration", null);
exports.PersonService = PersonService = __decorate([
    (0, common_1.Injectable)()
], PersonService);
//# sourceMappingURL=person.service.js.map
