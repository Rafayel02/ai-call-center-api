import { ArrayMaxSize, IsArray, IsIn, IsString, IsUUID, MaxLength } from 'class-validator';
import { SCENARIO_LANGUAGES } from '../scenario-languages';

export class FileAnswerDto {
  @IsString()
  @MaxLength(4000)
  query!: string;

  @IsArray()
  @ArrayMaxSize(80)
  @IsUUID('4', { each: true })
  resourceIds!: string[];

  @IsString()
  @IsIn(SCENARIO_LANGUAGES)
  language!: string;
}
