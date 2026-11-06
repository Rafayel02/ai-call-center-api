import { IsString, MaxLength } from 'class-validator';

export class CreateResourceDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(1_400_000)
  data!: string;
}
