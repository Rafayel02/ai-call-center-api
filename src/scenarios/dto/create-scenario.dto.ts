import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { SCENARIO_LANGUAGES, ScenarioLanguage } from '../scenario-languages';

export const SCENARIO_ICONS = [
  'sparkles',
  'orbit',
  'flower',
  'gem',
  'compass',
  'feather',
  'sun',
  'moon',
  'waves',
  'palette',
  'rocket',
  'zap',
  'cloud',
  'mountain',
  'leaf',
  'music',
  'hexagon',
  'audio',
] as const;

export class CreateScenarioDto {
  @IsUUID()
  organizationId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsIn([...SCENARIO_ICONS])
  icon!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn([...SCENARIO_LANGUAGES], { each: true })
  languages!: ScenarioLanguage[];
}
