import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';

export const DEMO_LANGUAGES = ['hy', 'en', 'ru'] as const;
export type DemoLanguage = (typeof DEMO_LANGUAGES)[number];

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

function emptyToNull(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class DemoProfileCopyDto {
  @IsIn(DEMO_LANGUAGES)
  language!: DemoLanguage;

  @Transform(({ value }) => clean(value))
  @IsString()
  @MinLength(1)
  @MaxLength(220)
  heading!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(800)
  introduction!: string;

  @IsArray()
  @ArrayMaxSize(8)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim() : item)).filter((item) => item !== '') : value))
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  starters!: string[];
}

export class SaveDemoProfileDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/)
  key!: string;

  @Transform(({ value }) => clean(value))
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  displayName!: string;

  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsUUID()
  scenarioId?: string | null;

  @IsIn(DEMO_LANGUAGES)
  defaultLanguage!: DemoLanguage;

  @IsBoolean()
  enabled!: boolean;

  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  accent?: string | null;

  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @Matches(/^https:\/\/\S{1,300}$/)
  logoUrl?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DemoProfileCopyDto)
  copies!: DemoProfileCopyDto[];
}

export class StartDemoSessionDto {
  @IsIn(DEMO_LANGUAGES)
  language!: DemoLanguage;
}
