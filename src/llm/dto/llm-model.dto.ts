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
}
