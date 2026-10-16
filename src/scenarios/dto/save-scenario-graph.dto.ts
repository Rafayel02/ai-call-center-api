import { IsArray } from 'class-validator';

export class SaveScenarioGraphDto {
  @IsArray()
  nodes!: unknown[];

  @IsArray()
  edges!: unknown[];
}
