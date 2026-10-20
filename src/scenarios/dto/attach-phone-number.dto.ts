import { IsUUID, ValidateIf } from 'class-validator';

export class AttachPhoneNumberDto {
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  phoneNumberId!: string | null;
}
