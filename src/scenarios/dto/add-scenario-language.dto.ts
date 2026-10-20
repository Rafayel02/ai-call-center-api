import { IsIn } from 'class-validator';
import { SCENARIO_LANGUAGES, ScenarioLanguage } from '../scenario-languages';

export class AddScenarioLanguageDto {
  @IsIn([...SCENARIO_LANGUAGES])
  language!: ScenarioLanguage;
}
