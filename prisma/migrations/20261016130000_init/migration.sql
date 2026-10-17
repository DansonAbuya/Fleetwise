-- CreateEnum
CREATE TYPE "DocKind" AS ENUM ('logbook', 'certificate', 'photo', 'agreement', 'collateral');

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "hasLogbook" BOOLEAN NOT NULL DEFAULT false,
    "hasAgreement" BOOLEAN NOT NULL DEFAULT false,
    "hasCertificate" BOOLEAN NOT NULL DEFAULT false,
    "hasPhoto" BOOLEAN NOT NULL DEFAULT false,
    "hasCollateral" BOOLEAN NOT NULL DEFAULT false,
    "present" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Needs attention',
    "commencement" TEXT,
    "expiry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" "DocKind" NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webViewLink" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plate_key" ON "Vehicle"("plate");

-- CreateIndex
CREATE UNIQUE INDEX "Document_vehicleId_type_key" ON "Document"("vehicleId", "type");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
