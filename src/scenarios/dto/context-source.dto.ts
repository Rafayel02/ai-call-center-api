import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class AddContextSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_400_000)
  data?: string;
}

export class LearnContextDto {
  @IsOptional()
  @IsObject()
  prompts?: Record<string, unknown>;
}
