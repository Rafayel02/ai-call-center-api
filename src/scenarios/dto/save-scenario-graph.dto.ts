import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { REALTIME_MODELS } from '../../telephony/realtime-models';

const REALTIME_MODEL_IDS = REALTIME_MODELS.map((model) => model.id);

export class SaveScenarioGraphDto {
  @IsArray()
  nodes!: unknown[];

  @IsArray()
  edges!: unknown[];

  @IsOptional()
  @IsObject()
  languageModels?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  askLanguage?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(REALTIME_MODEL_IDS)
  realtimeModel?: string;
}
