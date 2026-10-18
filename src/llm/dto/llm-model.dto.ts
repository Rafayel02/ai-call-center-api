import { LlmProvider } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateLlmModelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsEnum(LlmProvider)
  provider!: LlmProvider;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateLlmModelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class TestLlmDraftDto {
  @IsEnum(LlmProvider)
  provider!: LlmProvider;

  @IsObject()
  config!: Record<string, unknown>;
}

export class RouteCallDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  inquiry?: string;

  @IsArray()
  @ArrayMaxSize(40)
  messages!: unknown[];

  @IsArray()
  @ArrayMaxSize(8)
  topics!: unknown[];

  @IsString()
  @MaxLength(80)
  defaultTopicId!: string;
}

export class CompleteTurnDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  @IsArray()
  @ArrayMaxSize(40)
  messages!: unknown[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  topics?: unknown[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  defaultTopicId?: string;
}
