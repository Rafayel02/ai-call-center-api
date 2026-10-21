import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const DEMO_INDUSTRIES = [
  'Healthcare and dental',
  'Hotels and hospitality',
  'Beauty and wellness',
  'Retail and e-commerce',
  'Real estate',
  'Automotive and service',
  'Another industry',
] as const;

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

export class CreateDemoRequestDto {
  @Transform(({ value }) => clean(value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }) => clean(value))
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  businessName!: string;

  @Transform(({ value }) => clean(value))
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  contact!: string;

  @Transform(({ value }) => clean(value))
  @IsString()
  @IsIn(DEMO_INDUSTRIES)
  industry!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  needs!: string;
}
