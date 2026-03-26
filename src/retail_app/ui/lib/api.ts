import { useQuery, useSuspenseQuery, useMutation } from "@tanstack/react-query";
import type { UseQueryOptions, UseSuspenseQueryOptions, UseMutationOptions } from "@tanstack/react-query";
export class ApiError extends Error {
    status: number;
    statusText: string;
    body: unknown;
    constructor(status: number, statusText: string, body: unknown){
        super(`HTTP ${status}: ${statusText}`);
        this.name = "ApiError";
        this.status = status;
        this.statusText = statusText;
        this.body = body;
    }
}
export interface EventHubMessageOut {
    event_id: string;
    message: string;
    partition_key: string;
    status: string;
    timestamp: string;
    topic: string;
}
export interface FraudCheckLatency {
    backend_total_ms: number;
    model_call_ms: number;
    model_inference_ms?: number | null;
    model_lookup_ms?: number | null;
    model_total_ms?: number | null;
}
export interface HTTPValidationError {
    detail?: ValidationError[];
}
export interface TransactionIn {
    amount: number;
    country: string;
    country_code: string;
    credit_card_number: string;
    currency?: string;
}
export interface TransactionOut {
    amount: number;
    category: string;
    country: string;
    country_code: string;
    created_at: string;
    credit_card_number: string;
    currency: string;
    decline_reason?: string | null;
    fraud_flag?: number | null;
    fraud_probability?: number | null;
    id: string;
    latency?: FraudCheckLatency | null;
    merchant: string;
    status: TransactionStatus;
    transaction_number: string;
}
export const TransactionStatus = {
    pending: "pending",
    processing: "processing",
    completed: "completed",
    declined: "declined"
} as const;
export type TransactionStatus = typeof TransactionStatus[keyof typeof TransactionStatus];
export interface UserProfileIn {
    allow_international_transactions?: boolean;
    country_code: string;
    country_of_residence: string;
    daily_limit?: number;
    email: string;
    enable_notifications?: boolean;
    full_name: string;
    phone?: string | null;
    preferred_currency?: string;
    two_factor_enabled?: boolean;
}
export interface UserProfileOut {
    allow_international_transactions: boolean;
    country_code: string;
    country_of_residence: string;
    daily_limit: number;
    email: string;
    enable_notifications: boolean;
    eventhub_status: string;
    full_name: string;
    id: string;
    phone?: string | null;
    preferred_currency: string;
    two_factor_enabled: boolean;
    updated_at: string;
}
export interface ValidationError {
    ctx?: Record<string, unknown>;
    input?: unknown;
    loc: (string | number)[];
    msg: string;
    type: string;
}
export interface VersionOut {
    version: string;
}
export const getProfile = async (options?: RequestInit): Promise<{
    data: UserProfileOut;
}> =>{
    const res = await fetch("/api/profile", {
        ...options,
        method: "GET"
    });
    if (!res.ok) {
        const body = await res.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch  {
            parsed = body;
        }
        throw new ApiError(res.status, res.statusText, parsed);
    }
    return {
        data: await res.json()
    };
};
export const getProfileKey = ()=>{
    return [
        "/api/profile"
    ] as const;
};
export function useGetProfile<TData = {
    data: UserProfileOut;
}>(options?: {
    query?: Omit<UseQueryOptions<{
        data: UserProfileOut;
    }, ApiError, TData>, "queryKey" | "queryFn">;
}) {
    return useQuery({
        queryKey: getProfileKey(),
        queryFn: ()=>getProfile(),
        ...options?.query
    });
}
export function useGetProfileSuspense<TData = {
    data: UserProfileOut;
}>(options?: {
    query?: Omit<UseSuspenseQueryOptions<{
        data: UserProfileOut;
    }, ApiError, TData>, "queryKey" | "queryFn">;
}) {
    return useSuspenseQuery({
        queryKey: getProfileKey(),
        queryFn: ()=>getProfile(),
        ...options?.query
    });
}
export const updateProfile = async (data: UserProfileIn, options?: RequestInit): Promise<{
    data: EventHubMessageOut;
}> =>{
    const res = await fetch("/api/profile", {
        ...options,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...options?.headers
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch  {
            parsed = body;
        }
        throw new ApiError(res.status, res.statusText, parsed);
    }
    return {
        data: await res.json()
    };
};
export function useUpdateProfile(options?: {
    mutation?: UseMutationOptions<{
        data: EventHubMessageOut;
    }, ApiError, UserProfileIn>;
}) {
    return useMutation({
        mutationFn: (data)=>updateProfile(data),
        ...options?.mutation
    });
}
export const createTransaction = async (data: TransactionIn, options?: RequestInit): Promise<{
    data: TransactionOut;
}> =>{
    const res = await fetch("/api/transactions", {
        ...options,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...options?.headers
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch  {
            parsed = body;
        }
        throw new ApiError(res.status, res.statusText, parsed);
    }
    return {
        data: await res.json()
    };
};
export function useCreateTransaction(options?: {
    mutation?: UseMutationOptions<{
        data: TransactionOut;
    }, ApiError, TransactionIn>;
}) {
    return useMutation({
        mutationFn: (data)=>createTransaction(data),
        ...options?.mutation
    });
}
export const version = async (options?: RequestInit): Promise<{
    data: VersionOut;
}> =>{
    const res = await fetch("/api/version", {
        ...options,
        method: "GET"
    });
    if (!res.ok) {
        const body = await res.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch  {
            parsed = body;
        }
        throw new ApiError(res.status, res.statusText, parsed);
    }
    return {
        data: await res.json()
    };
};
export const versionKey = ()=>{
    return [
        "/api/version"
    ] as const;
};
export function useVersion<TData = {
    data: VersionOut;
}>(options?: {
    query?: Omit<UseQueryOptions<{
        data: VersionOut;
    }, ApiError, TData>, "queryKey" | "queryFn">;
}) {
    return useQuery({
        queryKey: versionKey(),
        queryFn: ()=>version(),
        ...options?.query
    });
}
export function useVersionSuspense<TData = {
    data: VersionOut;
}>(options?: {
    query?: Omit<UseSuspenseQueryOptions<{
        data: VersionOut;
    }, ApiError, TData>, "queryKey" | "queryFn">;
}) {
    return useSuspenseQuery({
        queryKey: versionKey(),
        queryFn: ()=>version(),
        ...options?.query
    });
}
