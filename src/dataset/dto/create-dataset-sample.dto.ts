import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDatasetSampleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  sentence!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  age?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  gender?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalId?: string;
}
