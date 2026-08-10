import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { logger } from "../../common/logger.js";

/**
 * Broadcast a ride status change to the `ride:{rideId}` channel
 * so the customer app (and driver app) can receive live updates.
 *
 * Uses the Supabase Realtime REST broadcast endpoint — stateless,
 * no .subscribe() needed, no socket leak.
 */
export async function broadcastRideStatus(
  rideId: string,
  status: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const url = `${env.SUPABASE_URL}/realtime/v1/api/broadcast`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{
          topic: `ride:${rideId}`,
          event: "status_change",
          payload: { status, ...payload },
        }],
      }),
    });

    if (!res.ok) {
      logger.warn({ rideId, status, httpStatus: res.status }, "Broadcast ride status failed");
    } else {
      logger.info({ rideId, status }, "Broadcasted ride status");
    }
  } catch (err) {
    logger.warn({ rideId, err }, "Broadcast ride status error (non-fatal)");
  }
}

/**
 * Broadcast an order status change to the `order:{orderId}` channel
 * so the customer app can receive live Q-Commerce updates.
 */
export async function broadcastOrderStatus(
  orderId: string,
  status: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    const url = `${env.SUPABASE_URL}/realtime/v1/api/broadcast`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{
          topic: `order:${orderId}`,
          event: "status_change",
          payload: { status, ...payload },
        }],
      }),
    });

    if (!res.ok) {
      logger.warn({ orderId, status, httpStatus: res.status }, "Broadcast order status failed");
    }
  } catch (err) {
    logger.warn({ orderId, err }, "Broadcast order status error");
  }
}

/**
 * Broadcast a ride offer to a specific driver via the `driver:{driverId}` channel.
 * Uses the same Realtime REST broadcast endpoint.
 */
export async function broadcastRideOffer(
  driverId: string,
  payload: {
    ride_id: string;
    origin_lat: number;
    origin_lng: number;
    origin_address?: string;
    dest_address?: string;
    vehicle_type: string;
    service_type?: string;
    cargo_weight_kg?: number;
    /** The fare the driver is offered — the customer's clamped bid, else the estimate. */
    fare_estimate?: number;
    /** The raw server estimate, for comparison against a boosted bid (fix A3). */
    base_estimate?: number;
    /** True when the customer offered above the estimate. */
    is_boosted?: boolean;
    distance_km?: number;
  }
): Promise<void> {
  try {
    const url = `${env.SUPABASE_URL}/realtime/v1/api/broadcast`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{
          topic: `driver:${driverId}`,
          event: "ride_offer",
          payload,
        }],
      }),
    });

    if (!res.ok) {
      logger.warn({ driverId, rideId: payload.ride_id, httpStatus: res.status }, "Broadcast ride offer failed");
    } else {
      logger.info({ driverId, rideId: payload.ride_id }, "Broadcasted ride offer");
    }
  } catch (err) {
    logger.warn({ driverId, err }, "Broadcast ride offer error (non-fatal)");
  }
}
