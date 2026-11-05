import { fingerprint } from '../storage/database.ts';
/** Only exact original turn identity and message prove a lost turn-start acknowledgement. */
export function humanActionObserved(proof:Record<string,unknown>,chat:any):boolean {
 if(proof.type!=='chat/turnStarted'||typeof proof.turnId!=='string'||typeof proof.messageHash!=='string'||!chat||!Array.isArray(chat.turns))return false;
 const turn=chat.activeTurn?.id===proof.turnId?chat.activeTurn:chat.turns.find((t:any)=>t?.id===proof.turnId);
 return !!turn&&fingerprint(turn.message)===proof.messageHash;
}
