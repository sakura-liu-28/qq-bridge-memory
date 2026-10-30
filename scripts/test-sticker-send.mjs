import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const bytes=Buffer.from('89504e470d0a1a0a00000000','hex'),sent=[];
const h=await bridgeHarness({globals:{safeFetchBuffer:async()=>({buffer:bytes}),fetch:async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({status:'ok',retcode:0,data:{message_id:1}})};}}});
try{
 await h.sendStickerV2('private:123','fixture-sticker');await h.sendStickerV2('group:456','fixture-sticker',{replyToMessageId:'-123',atUserId:'123'});
 for(const call of sent){const image=call.body.message.find(m=>m.type==='image');assert.deepEqual(JSON.parse(JSON.stringify(image.data)),{file:'base64://'+bytes.toString('base64'),sub_type:1,summary:'[动画表情]'});assert.equal(call.body.message.filter(m=>m.type==='text').length,0);}
 assert.equal(sent[0].body.user_id,123);assert.equal(sent[1].body.group_id,456);assert.equal(sent[1].body.message[0].type,'reply');
}finally{await h.close();}
console.log('PASS 收藏表情带 KCUSTOM=1，私聊/群聊路由、引用及安全字节发送不变');
