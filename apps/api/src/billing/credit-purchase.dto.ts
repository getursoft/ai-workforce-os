import { IsInt, IsString, Min } from "class-validator";

export class CreateCreditPurchaseOrderDto {
  @IsInt() @Min(1) credits!: number;
}

export class VerifyCreditPurchaseOrderDto {
  @IsString() razorpayOrderId!: string;
  @IsString() razorpayPaymentId!: string;
  @IsString() razorpaySignature!: string;
}
