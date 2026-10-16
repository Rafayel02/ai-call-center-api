import { TtsProvider } from '@prisma/client';
import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTextToSpeechModelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsEnum(TtsProvider)
  provider!: TtsProvider;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdateTextToSpeechModelDto {
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

export class TestTextToSpeechDraftDto {
  @IsEnum(TtsProvider)
  provider!: TtsProvider;

  @IsObject()
  config!: Record<string, unknown>;
}

export class SpeakDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  text!: string;
}
