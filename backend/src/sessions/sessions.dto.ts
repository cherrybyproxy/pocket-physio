// dto for creating a therapy session.

import { IsString, IsInt, IsIn, Matches, Min, Max, IsOptional } from 'class-validator';

export class CreateSessionDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in yyyy-mm-dd format' })
  date!: string;

  @IsString()
  time!: string; // e.g. "19:30 EDT"

  @IsString()
  @IsIn(['left', 'right'])
  injuredSide!: string;

  @IsInt()
  @Min(0)
  @Max(360)
  minAngle!: number;

  @IsInt()
  @Min(0)
  @Max(360)
  maxAngle!: number;

  @IsInt()
  @Min(0)
  @Max(360)
  rom!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  bodyLeanMax?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxLoad?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  flexReps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  extReps?: number;
}
