import { Transform } from 'class-transformer';
import { IsOptional, IsUUID, Matches } from 'class-validator';

const E164 = /^\+[1-9]\d{6,14}$/;
const E164_MESSAGE = 'Enter the number in international format, for example +15551234567.';

/** Accepts the number as people type it, with spaces, dashes, or brackets, and keeps only `+` and digits. */
const compact = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value);

export class CreatePhoneNumberDto {
  @Transform(compact)
  @Matches(E164, { message: E164_MESSAGE })
  e164!: string;

  @IsUUID()
  scenarioId!: string;
}

export class UpdatePhoneNumberDto {
  @IsOptional()
  @Transform(compact)
  @Matches(E164, { message: E164_MESSAGE })
  e164?: string;

  @IsOptional()
  @IsUUID()
  scenarioId?: string;
}
