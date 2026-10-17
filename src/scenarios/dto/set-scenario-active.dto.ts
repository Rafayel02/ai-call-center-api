import { IsBoolean } from 'class-validator';

export class SetScenarioActiveDto {
  @IsBoolean()
  active!: boolean;
}
