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
exports.OcrService = void 0;
const common_1 = require("@nestjs/common");
const constants_1 = require("../constants");
const decorators_1 = require("../decorators");
const enum_1 = require("../enum");
const base_service_1 = require("./base.service");
const database_1 = require("../utils/database");
const misc_1 = require("../utils/misc");
let OcrService = class OcrService extends base_service_1.BaseService {
    async handleQueueOcr({ force }) {
        const { machineLearning } = await this.getConfig({ withCache: false });
        if (!(0, misc_1.isOcrEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        if (force) {
            await this.ocrRepository.deleteAll();
        }
        let jobs = [];
        const assets = this.assetJobRepository.streamForOcrJob(force);
        for await (const asset of assets) {
            jobs.push({ name: enum_1.JobName.Ocr, data: { id: asset.id } });
            if (jobs.length >= constants_1.JOBS_ASSET_PAGINATION_SIZE) {
                await this.jobRepository.queueAll(jobs);
                jobs = [];
            }
        }
        await this.jobRepository.queueAll(jobs);
        return enum_1.JobStatus.Success;
    }
    async handleOcr({ id }) {
        const { machineLearning } = await this.getConfig({ withCache: true });
        if (!(0, misc_1.isOcrEnabled)(machineLearning)) {
            return enum_1.JobStatus.Skipped;
        }
        const asset = await this.assetJobRepository.getForOcr(id);
        if (!asset?.originalPath) {
            return enum_1.JobStatus.Failed;
        }
        if (asset.visibility === enum_1.AssetVisibility.Hidden) {
            return enum_1.JobStatus.Skipped;
        }
        const ocrResults = await this.machineLearningRepository.ocr(asset.originalPath, machineLearning.ocr);
        const { ocrDataList, searchText } = this.parseOcrResults(id, ocrResults);
        await this.ocrRepository.upsert(id, ocrDataList, searchText);
        await this.assetRepository.upsertJobStatus({ assetId: id, ocrAt: new Date() });
        this.logger.debug(`Processed ${ocrResults.text.length} OCR result(s) for ${id}`);
        return enum_1.JobStatus.Success;
    }
    parseOcrResults(id, { box, boxScore, text, textScore }) {
        const ocrDataList = [];
        const searchTokens = [];
        for (let i = 0; i < text.length; i++) {
            const rawText = text[i];
            const boxOffset = i * 8;
            ocrDataList.push({
                assetId: id,
                x1: box[boxOffset],
                y1: box[boxOffset + 1],
                x2: box[boxOffset + 2],
                y2: box[boxOffset + 3],
                x3: box[boxOffset + 4],
                y3: box[boxOffset + 5],
                x4: box[boxOffset + 6],
                y4: box[boxOffset + 7],
                boxScore: boxScore[i],
                textScore: textScore[i],
                text: rawText,
            });
            searchTokens.push(...(0, database_1.tokenizeForSearch)(rawText));
        }
        return { ocrDataList, searchText: searchTokens.join(' ') };
    }
};
exports.OcrService = OcrService;
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.OcrQueueAll, queue: enum_1.QueueName.Ocr }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], OcrService.prototype, "handleQueueOcr", null);
__decorate([
    (0, decorators_1.OnJob)({ name: enum_1.JobName.Ocr, queue: enum_1.QueueName.Ocr }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], OcrService.prototype, "handleOcr", null);
exports.OcrService = OcrService = __decorate([
    (0, common_1.Injectable)()
], OcrService);
//# sourceMappingURL=ocr.service.js.map
