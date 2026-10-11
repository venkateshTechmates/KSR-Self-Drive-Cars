// Importing these modules registers their RPCs (defineRpc) with the registry.
import './misc.ts';
import './booking.ts';
import './documents.ts';
import './customers.ts';

export { getRpc, rpcNames } from './registry.ts';
