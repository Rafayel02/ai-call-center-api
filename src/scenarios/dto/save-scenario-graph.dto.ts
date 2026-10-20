import { IsArray, IsBoolean, IsObject, IsOptional } from 'class-validator';

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
}
