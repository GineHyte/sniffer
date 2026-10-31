// Minimal, dependency-free XML reader for CII invoices (Task 26, A6).
// Only used to pick domain fields for the investigators. Element names are matched by local name.
// DOCTYPE is refused (no entity expansion); only the five predefined and numeric character references are decoded.
// The input is untrusted: every value is returned as a clipped plain string, never interpreted.

export const MAX_XML_NODES=50000;
const ENTITIES={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'"};

function decode(text){
 return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g,(match,ref)=>{
  if(ref[0]==='#'){
   const code=ref[1]==='x'||ref[1]==='X'?parseInt(ref.slice(2),16):parseInt(ref.slice(1),10);
   return Number.isInteger(code)&&code>0&&code<=0x10ffff?String.fromCodePoint(code):match;
  }
  return Object.hasOwn(ENTITIES,ref)?ENTITIES[ref]:match;
 });
}

const localName=qname=>qname.includes(':')?qname.slice(qname.indexOf(':')+1):qname;

function parseAttributes(text){
 const attrs=Object.create(null);
 for(const match of text.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))attrs[localName(match[1])]=decode(match[2]??match[3]??'');
 return attrs;
}

/** Parses an XML document and returns its document element {name, qname, attrs, children, text}. Throws on malformed input. */
export function parseXml(text,{maxNodes=MAX_XML_NODES}={}){
 if(typeof text!=='string')throw new Error('XML must be a string');
 const src=text.charCodeAt(0)===0xfeff?text.slice(1):text;
 const root={name:'#document',qname:'#document',attrs:Object.create(null),children:[],text:''};
 const stack=[root];
 let i=0;let nodes=0;
 const need=(index,what)=>{if(index<0)throw new Error(`Malformed XML: unterminated ${what}`);return index;};
 while(i<src.length){
  const lt=src.indexOf('<',i);
  if(lt<0){stack.at(-1).text+=decode(src.slice(i));break;}
  if(lt>i)stack.at(-1).text+=decode(src.slice(i,lt));
  if(src.startsWith('<!--',lt)){i=need(src.indexOf('-->',lt+4),'comment')+3;continue;}
  if(src.startsWith('<![CDATA[',lt)){const end=need(src.indexOf(']]>',lt+9),'CDATA');stack.at(-1).text+=src.slice(lt+9,end);i=end+3;continue;}
  if(src.startsWith('<?',lt)){i=need(src.indexOf('?>',lt+2),'processing instruction')+2;continue;}
  if(src.startsWith('<!',lt))throw new Error('XML with DOCTYPE or declarations is not supported');
  if(src.startsWith('</',lt)){
   const end=need(src.indexOf('>',lt),'end tag');
   const qname=src.slice(lt+2,end).trim();
   const top=stack.pop();
   if(stack.length===0||top.qname!==qname)throw new Error('Malformed XML: mismatched end tag');
   i=end+1;continue;
  }
  let j=lt+1;let quote=null;
  for(;j<src.length;j++){const c=src[j];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
  need(j<src.length?j:-1,'start tag');
  let inner=src.slice(lt+1,j);
  const selfClosing=inner.endsWith('/');
  if(selfClosing)inner=inner.slice(0,-1);
  const qname=/^[^\s/>]+/.exec(inner)?.[0];
  if(!qname)throw new Error('Malformed XML: empty tag name');
  if(++nodes>maxNodes)throw new Error('XML has too many elements');
  const node={name:localName(qname),qname,attrs:parseAttributes(inner.slice(qname.length)),children:[],text:''};
  if(stack.length===1&&root.children.length)throw new Error('Malformed XML: more than one document element');
  stack.at(-1).children.push(node);
  if(!selfClosing)stack.push(node);
  i=j+1;
 }
 if(stack.length!==1)throw new Error('Malformed XML: unclosed element');
 if(root.children.length!==1)throw new Error('Malformed XML: no document element');
 return root.children[0];
}

export function children(node,name){return node?node.children.filter(child=>child.name===name):[];}
export function child(node,name){return node?.children.find(entry=>entry.name===name);}
/** Follows a '/'-separated path of local names, taking the first match at each step. */
export function at(node,path){
 let current=node;
 for(const step of path.split('/')){current=child(current,step);if(!current)return undefined;}
 return current;
}
export function clip(value,max=300){
 if(typeof value!=='string')return null;
 const text=value.replace(/\s+/g,' ').trim();
 if(!text)return null;
 const chars=[...text];
 return chars.length>max?`${chars.slice(0,max-1).join('')}…`:text;
}
export function textAt(node,path,max){return clip(at(node,path)?.text,max);}

const compact=object=>Object.fromEntries(Object.entries(object).filter(([,value])=>value!==null&&value!==undefined&&!(Array.isArray(value)&&!value.length)));

function address(party){
 const postal=child(party,'PostalTradeAddress');
 if(!postal)return null;
 return compact({line_one:textAt(postal,'LineOne'),line_two:textAt(postal,'LineTwo'),line_three:textAt(postal,'LineThree'),
  postcode:textAt(postal,'PostcodeCode',20),city:textAt(postal,'CityName',100),country:textAt(postal,'CountryID',10)});
}

function taxRegistrations(party){
 const out={};
 for(const registration of children(party,'SpecifiedTaxRegistration')){
  const id=child(registration,'ID');
  const scheme=id?.attrs.schemeID;
  const value=clip(id?.text,40);
  if(!value)continue;
  if(scheme==='VA'&&!out.vat_id)out.vat_id=value;
  else if(scheme==='FC'&&!out.tax_number)out.tax_number=value;
 }
 return out;
}

/**
 * Picks the investigator-relevant fields of a CII invoice (CrossIndustryInvoice).
 * Returns {invoice, wallet, supplier}; any field may be missing. Throws only on malformed XML.
 */
export function extractInvoiceFields(xml,{maxLineItems=30,maxNotes=5}={}){
 const doc=parseXml(xml);
 if(doc.name!=='CrossIndustryInvoice')throw new Error('Not a CII CrossIndustryInvoice document');
 const exchanged=child(doc,'ExchangedDocument');
 const transaction=child(doc,'SupplyChainTradeTransaction');
 const agreement=child(transaction,'ApplicableHeaderTradeAgreement');
 const settlement=child(transaction,'ApplicableHeaderTradeSettlement');
 const seller=child(agreement,'SellerTradeParty');
 const sums=child(settlement,'SpecifiedTradeSettlementHeaderMonetarySummation');
 const lineItems=children(transaction,'IncludedSupplyChainTradeLineItem');
 const means=children(settlement,'SpecifiedTradeSettlementPaymentMeans');
 const payee=means.find(entry=>textAt(entry,'PayeePartyCreditorFinancialAccount/ProprietaryID',200));
 const contact=child(seller,'DefinedTradeContact');
 const terms=children(settlement,'SpecifiedTradePaymentTerms');

 const invoice=compact({
  notes:children(exchanged,'IncludedNote').map(note=>textAt(note,'Content',500)).filter(Boolean).slice(0,maxNotes),
  buyer_reference:textAt(agreement,'BuyerReference',100),
  order_reference:textAt(agreement,'BuyerOrderReferencedDocument/IssuerAssignedID',100),
  contract_reference:textAt(agreement,'ContractReferencedDocument/IssuerAssignedID',100),
  delivery_date:textAt(transaction,'ApplicableHeaderTradeDelivery/ActualDeliverySupplyChainEvent/OccurrenceDateTime/DateTimeString',20),
  currency:textAt(settlement,'InvoiceCurrencyCode',10),
  payment_terms:terms.map(term=>textAt(term,'Description',300)).filter(Boolean).slice(0,3),
  line_item_count:lineItems.length,
  line_items:lineItems.slice(0,maxLineItems).map(item=>{
   const quantity=at(item,'SpecifiedLineTradeDelivery/BilledQuantity');
   return compact({line_id:textAt(item,'AssociatedDocumentLineDocument/LineID',40),name:textAt(item,'SpecifiedTradeProduct/Name',200),
    quantity:clip(quantity?.text,30),unit_code:clip(quantity?.attrs.unitCode,10),
    net_price:textAt(item,'SpecifiedLineTradeAgreement/NetPriceProductTradePrice/ChargeAmount',30),
    vat_rate_percent:textAt(item,'SpecifiedLineTradeSettlement/ApplicableTradeTax/RateApplicablePercent',10),
    line_total:textAt(item,'SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount',30)});
  }),
  totals:sums?compact({line_total:textAt(sums,'LineTotalAmount',30),charge_total:textAt(sums,'ChargeTotalAmount',30),allowance_total:textAt(sums,'AllowanceTotalAmount',30),
   tax_basis_total:textAt(sums,'TaxBasisTotalAmount',30),tax_total:textAt(sums,'TaxTotalAmount',30),grand_total:textAt(sums,'GrandTotalAmount',30),
   prepaid:textAt(sums,'TotalPrepaidAmount',30),due_payable:textAt(sums,'DuePayableAmount',30)}):null,
 });
 const wallet=compact({
  address:textAt(payee,'PayeePartyCreditorFinancialAccount/ProprietaryID',200),
  payment_means_code:textAt(payee??means[0],'TypeCode',10),
  payment_information:textAt(payee??means[0],'Information',200),
 });
 const supplier=seller?compact({
  name:textAt(seller,'Name',200),
  trading_name:textAt(seller,'SpecifiedLegalOrganization/TradingBusinessName',200),
  legal_registration_id:textAt(seller,'SpecifiedLegalOrganization/ID',60),
  ...taxRegistrations(seller),
  address:address(seller),
  electronic_address:textAt(seller,'URIUniversalCommunication/URIID',200),
  contact:contact?compact({person:textAt(contact,'PersonName',120),department:textAt(contact,'DepartmentName',120),
   phone:textAt(contact,'TelephoneUniversalCommunication/CompleteNumber',60),email:textAt(contact,'EmailURIUniversalCommunication/URIID',200)}):null,
 }):{};
 return {invoice,wallet,supplier};
}
