import { ExecutionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class CreateScenarioExecutionDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  scenarioId!: string;

  @IsObject()
  graph!: Record<string, unknown>;
}

export class ExecutionEventDto {
  @IsInt()
  @Min(0)
  clientSeq!: number;

  @IsInt()
  @Min(0)
  offsetMs!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  nodeId?: string | null;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class PostExecutionEventsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExecutionEventDto)
  events!: ExecutionEventDto[];
}

const FINISH_STATUSES = [ExecutionStatus.FINISHED, ExecutionStatus.STOPPED, ExecutionStatus.FAILED] as const;

export class FinishScenarioExecutionDto {
  @IsIn(FINISH_STATUSES)
  status!: (typeof FINISH_STATUSES)[number];

  @IsInt()
  @Min(0)
  durationMs!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  inquiry?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  topicId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  topicLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string | null;
}
