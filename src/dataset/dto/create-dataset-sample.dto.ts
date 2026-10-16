import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDatasetSampleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  transcript!: string;
}
