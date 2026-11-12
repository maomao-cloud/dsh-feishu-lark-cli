export type ReceiveMode = 'polling' | 'disabled';
export type AccountAuthStatus = 'authorized' | 'expired' | 'revoked';
export type TargetType = 'user' | 'chat';
export interface Account { id:string; openId:string; name:string; tenantKey:string; tenantName?:string; profile:string; isDefault:boolean; receiveEnabled:boolean; receiveMode:ReceiveMode; authStatus:AccountAuthStatus; }
export interface OperationContext { account:Account; target?: { type:TargetType; id:string; name:string; tenantKey?:string }; }
export interface ReceivedMessage { accountId:string; messageId:string; chatId:string; chatType:'p2p'|'group'; senderOpenId:string; messageType:string; content:string; rootId?:string; parentId?:string; threadId?:string; createTime:string; source:'polling'; }
export interface CliResult<T=unknown> { ok:boolean; identity?:string; data?:T; error?:{type:string;subtype?:string;message:string;hint?:string;missing_scopes?:string[]}; }
