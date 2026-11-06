import { IsString, MaxLength } from 'class-validator';

export class ImportSiteDto {
  @IsString()
  @MaxLength(2000)
  url!: string;
}
