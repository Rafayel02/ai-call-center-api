import { SttProvider } from '@prisma/client';
import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSpeechModelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsEnum(SttProvider)
  provider!: SttProvider;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateSpeechModelDto {
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

export class TestDraftDto {
  @IsEnum(SttProvider)
  provider!: SttProvider;

  @IsObject()
  config!: Record<string, unknown>;
}
