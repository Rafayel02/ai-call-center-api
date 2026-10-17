import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class PreviewComparisonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  modelIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  sampleIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  count?: number;
}

export class RunCheckDto {
  @IsUUID('all')
  modelId!: string;

  @IsUUID('all')
  sampleId!: string;
}
