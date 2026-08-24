// auth dto — validation rules for registration and login payloads.

import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class AuthDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
