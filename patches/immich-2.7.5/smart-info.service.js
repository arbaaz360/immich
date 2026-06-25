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
exports.SmartInfoService = void 0;
const common_1 = require("@nestjs/common");
const constants_1 = require("../constants");
const decorators_1 = require("../decorators");
const enum_1 = require("../enum");
const base_service_1 = require("./base.service");
const misc_1 = require("../utils/misc");
let SmartInfoService = class SmartInfoService extends base_service_1.BaseService {
    async onConfigInit({ newConfig }) {
        await this.init(newConfig);
    }
    async onConfigUpdate({ oldConfig, newConfig }) {
        await this.init(newConfig, oldConfig);
    }
    onConfigValidate({ newConfig }) {
        try {
            (0, misc_1.getCLIPModelInfo)(newConfig.machineLearning.clip.modelName);
        }
        catch {
            throw new Error(`Unknown CLIP model: ${newConfig.machineLearning.clip.modelName}. Please check the model name for typos and confirm this is a supported model.`);
        }
    }
    async init(newConfig, oldConfig) {
        if (!(0, misc_1.isSmartSearchEnabled)(newConfig.machineLearning)) {
            return;
        }
        await this.databaseRepository.withLock(enum_1.DatabaseLock.CLIPDimSize, async () => {
            const { dimSize } = (0, misc_1.getCLIPModelInfo)(newConfig.machineLearning.clip.modelName);
            const dbDimSize = await this.databaseRepository.getDimensionSize('smart_search');
            this.logger.verbose(`Current database CLIP dimension size is ${dbDimSize}`);
            const modelChange = oldConfig && oldConfig.machineLearning.clip.modelName !== newConfig.machineLearning.clip.modelName;
            const dimSizeChange = dbDimSize !== dimSize;
            if (!modelChange && !dimSizeChange) {
                return;
            }
            if (dimSizeChange) {
                this.logger.log(`Dimension size of model ${newConfig.machineLearning.clip.modelName} is ${dimSize}, but database expects ${dbDimSize}.`);
                this.logger.log(`Updating database CLIP dimension size to ${dimSize}.`);
                await this.databaseRepository.setDimensionSize(dimSize);
                this.logger.log(`Successfully updated database CLIP dimension size from ${dbDimSize} to ${dimSize}.`);
            }
            else {
                await this.databaseRepository.deleteAllSearchEmbeddings();
            }
        });
    }
    async handleQueueEncodeClip({ force }) {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!(0, misc_1.isSmartSearchEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        if (force) {
            const { dimSize } = (0, misc_1.getCLIPModelInfo)(machineLearning.clip.modelName);
            await this.databaseRepository.setDimensionSize(dimSize);
        }
        let queue = [];
        const assets = this.assetJobRepository.streamForEncodeClip(force);
        for await (const asset of assets) {
            queue.push({ name: enum_1.JobName.SmartSearch, data: { id: asset.id } });
            if (queue.length >= constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await this.jobRepository.queueAll(queue);
                queue = [];
            }
        }
        await this.jobRepository.queueAll(queue);
        return enum_1.JobStatus.Success;
    }
    async handleEncodeClip({ id }) {
        const { machineLearning } = await this.getConfig({ withCache: true });
        if (!(0, misc_1.isSmartSearchEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        const asset = await this.assetJobRepository.getForClipEncoding(id);
        if (!asset?.originalPath) {
            return enum_1.JobStatus.Failed;
        }
        if (asset.visibility === enum_1.AssetVisibility.Hidden) {
            return enum_1.JobStatus.Skipped;
        }
        const embedding = await this.machineLearningRepository.encodeImage(asset.originalPath, machineLearning.clip);
        if (this.databaseRepository.isBusy(enum_1.DatabaseLock.CLIPDimSize)) {
            this.logger.verbose(`Waiting for CLIP dimension size to be updated`);
            await this.databaseRepository.wait(enum_1.DatabaseLock.CLIPDimSize);
        }
        const newConfig = await this.getConfig({ withCache: true });
        if (machineLearning.clip.modelName !== newConfig.machineLearning.clip.modelName) {
            return enum_1.JobStatus.Skipped;
        }
        await this.searchRepository.upsert(asset.id, embedding);
        return enum_1.JobStatus.Success;
    }
};
exports.SmartInfoService = SmartInfoService;
__decorate([
    (0, decorators_1.OnEvent)({ name: 'ConfigInit', workers: [enum_1.ImmichWorker.Microservices] }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SmartInfoService.prototype, "onConfigInit", null);
__decorate([
    (0, decorators_1.OnEvent)({ name: 'ConfigUpdate', workers: [enum_1.ImmichWorker.Microservices], server: true }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SmartInfoService.prototype, "onConfigUpdate", null);
__decorate([
    (0, decorators_1.OnEvent)({ name: 'ConfigValidate' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SmartInfoService.prototype, "onConfigValidate", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.SmartSearchQueueAll, queue: enum_1.QueueName.SmartSearch }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SmartInfoService.prototype, "handleQueueEncodeClip", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.SmartSearch, queue: enum_1.QueueName.SmartSearch }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SmartInfoService.prototype, "handleEncodeClip", null);
exports.SmartInfoService = SmartInfoService = __decorate([
    (0, common_1.Injectable)()
], SmartInfoService);
//# sourceMappingURL=smart-info.service.js.map
