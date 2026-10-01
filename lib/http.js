/* Stateless Streamable-HTTP handler: one fresh MCP server per request (works on Cloud Functions). */
const {StreamableHTTPServerTransport}=require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {buildServer}=require('./mcp');
async function handleMcp(req,res,store){
  if(req.method==='GET'||req.method==='DELETE'){ res.status(405).set('Allow','POST').json({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed'},id:null}); return; }
  const server=buildServer(store);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{ transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
}
module.exports={handleMcp};
