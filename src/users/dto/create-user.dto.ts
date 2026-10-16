import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  @Matches(/[A-Za-z]/, { message: 'Password must include a letter.' })
  @Matches(/\d/, { message: 'Password must include a number.' })
  password!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  confirmPassword!: string;
}
