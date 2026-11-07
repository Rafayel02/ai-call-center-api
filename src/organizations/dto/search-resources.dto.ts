import { IsString, MaxLength, MinLength } from 'class-validator';

export class SearchResourcesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  query!: string;
}
