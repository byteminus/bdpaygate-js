import type { GatewayClass } from '../core/gateway.js';
import { AamarPayGateway } from './aamarpay.js';
import { BkashGateway } from './bkash.js';
import { DgePayGateway } from './dgepay.js';
import { EpsGateway } from './eps.js';
import { FakeGateway } from './fake.js';
import { MoneybagGateway } from './moneybag.js';
import { NagadGateway } from './nagad.js';
import { PayStationGateway } from './paystation.js';
import { PortPosGateway } from './portpos.js';
import { ShurjoPayGateway } from './shurjopay.js';
import { SslCommerzGateway } from './sslcommerz.js';
import { UddoktaPayGateway } from './uddoktapay.js';
import { UpayGateway } from './upay.js';

/** Built-in drivers, by the `driver` key used in config. */
export const DRIVERS: Record<string, GatewayClass> = {
  bkash: BkashGateway,
  sslcommerz: SslCommerzGateway,
  nagad: NagadGateway,
  upay: UpayGateway,
  shurjopay: ShurjoPayGateway,
  aamarpay: AamarPayGateway,
  portpos: PortPosGateway,
  paystation: PayStationGateway,
  uddoktapay: UddoktaPayGateway,
  moneybag: MoneybagGateway,
  eps: EpsGateway,
  dgepay: DgePayGateway,
  fake: FakeGateway,
};

export {
  AamarPayGateway,
  BkashGateway,
  DgePayGateway,
  EpsGateway,
  FakeGateway,
  MoneybagGateway,
  NagadGateway,
  PayStationGateway,
  PortPosGateway,
  ShurjoPayGateway,
  SslCommerzGateway,
  UddoktaPayGateway,
  UpayGateway,
};
