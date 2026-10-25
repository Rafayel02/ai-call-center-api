import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { REALTIME_MODELS } from '../../telephony/realtime-models';
import { VOICE_MODES, VOICE_PROMPT_LIMIT } from '../../telephony/realtime-brief';

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

  @IsOptional()
  @IsString()
  @IsIn(VOICE_MODES)
  voiceMode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(VOICE_PROMPT_LIMIT)
  voicePrompt?: string;
}
