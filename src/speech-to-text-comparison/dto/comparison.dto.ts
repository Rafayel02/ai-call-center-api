import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** The most new checks one run can send. Also caps the automatic count and the number of chosen samples. */
export const MAX_RUN = 100;

export class PreviewComparisonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  modelIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RUN)
  @IsUUID('all', { each: true })
  sampleIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_RUN)
  count?: number;
}

export class RunCheckDto {
  @IsUUID('all')
  modelId!: string;

  @IsUUID('all')
  sampleId!: string;
}
