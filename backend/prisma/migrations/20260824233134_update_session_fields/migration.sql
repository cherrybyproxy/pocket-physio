/*
  Warnings:

  - You are about to drop the column `leftRom` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `rightRom` on the `Session` table. All the data in the column will be lost.
  - Added the required column `maxAngle` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `minAngle` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `rom` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `time` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Session" DROP COLUMN "leftRom",
DROP COLUMN "rightRom",
ADD COLUMN     "maxAngle" INTEGER NOT NULL,
ADD COLUMN     "minAngle" INTEGER NOT NULL,
ADD COLUMN     "rom" INTEGER NOT NULL,
ADD COLUMN     "time" TEXT NOT NULL,
ALTER COLUMN "bodyLeanMax" SET DEFAULT 0;
