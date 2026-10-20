import { IsOptional, IsUUID, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

const E164 = /^\+[1-9]\d{6,14}$/;

const compact = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value);

export class CreatePhoneNumberDto {
  @Transform(compact)
  @Matches(E164, { message: 'Enter the number in international format, for example +15551234567.' })
  e164!: string;

  @IsUUID()
  streamingServiceId!: string;
}

export class UpdatePhoneNumberDto {
  @IsOptional()
  @Transform(compact)
  @Matches(E164, { message: 'Enter the number in international format, for example +15551234567.' })
  e164?: string;

  @IsOptional()
  @IsUUID()
  streamingServiceId?: string;
}
