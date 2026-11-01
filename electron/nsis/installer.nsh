; Windows: make Adam a handler for adam:// and every Apple Music scheme it can open (the list matches
; APPLE_SCHEMES in deeplink.mjs; a test keeps them in sync).
;  - Each scheme gets a protocol key (so Settings -> Apps -> Default apps -> Adam lists it) and a capability entry
;    (so Adam is selectable under "Choose defaults by link type").
;  - A scheme that another app already owns is not touched: its protocol key is left alone and Adam is only offered
;    as a choice. Windows decides the final default; pick Adam there if it is not already used.
;  - Uninstall removes only the protocol keys that still point at this install.

!macro AdamScheme SCHEME
  Push $0
  ClearErrors
  ReadRegStr $0 HKCR "${SCHEME}" "URL Protocol"
  ${If} ${Errors}
    WriteRegStr SHCTX "Software\Classes\${SCHEME}" "" "URL:${SCHEME}"
    WriteRegStr SHCTX "Software\Classes\${SCHEME}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\${SCHEME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    WriteRegStr SHCTX "Software\Classes\${SCHEME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${EndIf}
  WriteRegStr SHCTX "Software\Adam\Capabilities\URLAssociations" "${SCHEME}" "AdamURL"
  Pop $0
!macroend

!macro AdamSchemeRemove SCHEME
  Push $0
  ReadRegStr $0 SHCTX "Software\Classes\${SCHEME}\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey SHCTX "Software\Classes\${SCHEME}"
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\AdamURL" "" "Adam link"
  WriteRegStr SHCTX "Software\Classes\AdamURL" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\AdamURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\AdamURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Adam\Capabilities" "ApplicationName" "Adam"
  WriteRegStr SHCTX "Software\Adam\Capabilities" "ApplicationDescription" "Apple Music desktop client"
  !insertmacro AdamScheme "adam"
  !insertmacro AdamScheme "music"
  !insertmacro AdamScheme "musics"
  !insertmacro AdamScheme "itms"
  !insertmacro AdamScheme "itmss"
  !insertmacro AdamScheme "itunes"
  !insertmacro AdamScheme "itals"
  !insertmacro AdamScheme "italss"
  !insertmacro AdamScheme "itvls"
  !insertmacro AdamScheme "itvlss"
  !insertmacro AdamScheme "itsradio"
  !insertmacro AdamScheme "itunesradio"
  !insertmacro AdamScheme "daap"
  !insertmacro AdamScheme "itpc"
  !insertmacro AdamScheme "itunes.assocprotocol.daap"
  !insertmacro AdamScheme "itunes.assocprotocol.itals"
  !insertmacro AdamScheme "itunes.assocprotocol.italss"
  !insertmacro AdamScheme "itunes.assocprotocol.itls"
  !insertmacro AdamScheme "itunes.assocprotocol.itlss"
  !insertmacro AdamScheme "itunes.assocprotocol.itms"
  !insertmacro AdamScheme "itunes.assocprotocol.itmss"
  !insertmacro AdamScheme "itunes.assocprotocol.itpc"
  !insertmacro AdamScheme "itunes.assocprotocol.itsradio"
  !insertmacro AdamScheme "itunes.assocprotocol.itvls"
  !insertmacro AdamScheme "itunes.assocprotocol.itvlss"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Adam" "Software\Adam\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro AdamSchemeRemove "music"
  !insertmacro AdamSchemeRemove "musics"
  !insertmacro AdamSchemeRemove "itms"
  !insertmacro AdamSchemeRemove "itmss"
  !insertmacro AdamSchemeRemove "itunes"
  !insertmacro AdamSchemeRemove "itals"
  !insertmacro AdamSchemeRemove "italss"
  !insertmacro AdamSchemeRemove "itvls"
  !insertmacro AdamSchemeRemove "itvlss"
  !insertmacro AdamSchemeRemove "itsradio"
  !insertmacro AdamSchemeRemove "itunesradio"
  !insertmacro AdamSchemeRemove "daap"
  !insertmacro AdamSchemeRemove "itpc"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.daap"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itals"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.italss"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itls"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itlss"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itms"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itmss"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itpc"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itsradio"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itvls"
  !insertmacro AdamSchemeRemove "itunes.assocprotocol.itvlss"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Adam"
  DeleteRegKey SHCTX "Software\Adam"
  DeleteRegKey SHCTX "Software\Classes\AdamURL"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
