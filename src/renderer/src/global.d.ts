import type { TransferApi } from '../../preload'

declare global {
  interface Window {
    transfer: TransferApi
  }
}

export {}
